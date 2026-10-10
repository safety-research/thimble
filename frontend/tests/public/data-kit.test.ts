// The view kit's search, table and diff (backend/app/viewer_search.js, viewer_table.js, viewer_diff.js), in a jsdom
// window of their own with the rest of the kit as views.frame_document loads it. Each works alone on plain records, with
// no Color by, time range or side panel: the search finds text case ignored across a record's inline elements and never
// in the kit's own controls, steps through the matches and wraps, finds in the rows a list gives it and in a fold it
// opens (the words a transcript or a record folds away among them, kept in the page hidden), puts its ticks on the list's
// strip, and Reset empties it; the table draws only the rows near its view, sorts by a
// click on a column's head with the rows with no value last, hides what Filter by does not keep, gives Color by its bars
// and the counts of every row, opens a row in the side panel and keeps its sort; the diff aligns the lines, marks the
// words that changed, folds the unchanged stretches with Show more and Show less, and draws side by side or inline, and
// draws a patch, each file under its head and each hunk numbered from its @@ line; the
// text (viewer_text.js, with the markdown parser of src/lib/kitMarkdown.ts) turns mentions into links that open their
// record, shows raw HTML as text, takes every link's address off, and folds a long text with Show more.
// The messages (viewer_messages.js) share a head between one author's messages that follow each other within five
// minutes with the same parent on one day, and keep each message its own anchored element.
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

  test("a transcript keeps a folded turn's words and a long block's lines past the sixth in the page, hidden; going to a match there opens the turn, as a click does, then the block", async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="turns"></div>`)
    const w = win()
    w.TURNS = [
      { ref: 's.jsonl#L1', speaker: 'lead', kind: 'tool', tool: 'Bash', input: 'grep -n . birds.txt', output: Array.from({ length: 12 }, (_, i) => (i === 8 ? 'osprey, near the dam' : `gull ${i + 1}`)).join('\n') },
      { ref: 's.jsonl#L2', speaker: 'lead', kind: 'text', text: Array.from({ length: 20 }, (_, i) => (i === 14 ? 'a kestrel hovers' : `line ${i + 1}`)).join('\n') },
    ]
    w.eval(`
      window.opened = []
      window.tr = thimble.transcript({ mount: '#turns', onOpen: (t) => window.opened.push(t.ref) })
      tr.draw(window.TURNS)
      window.search = thimble.search({ mount: '#search', in: '#turns' })
    `)
    const tool = doc().querySelector('[data-anchor="s.jsonl#L1"]')!
    const notes = doc().querySelector('[data-anchor="s.jsonl#L2"]')!
    // the folded call: its one line is the page's wording, its call and what came back in a hidden fold
    expect(tool.querySelector('.thimble-turn-line')!.hasAttribute('data-thimble-chrome')).toBe(true)
    expect(tool.querySelector('.thimble-turn-call')).toBeNull()
    const words = tool.querySelector<HTMLElement>('[data-thimble-fold]')!
    expect(words.hidden).toBe(true)
    expect([...words.children].map((c) => c.textContent)).toEqual(['Bash\ngrep -n . birds.txt', w.TURNS[0].output])
    // the long block: its first six lines, then the rest in a hidden fold in the same block
    const block = notes.querySelector('.thimble-turn-block')!
    const rest = block.querySelector<HTMLElement>('[data-thimble-fold]')!
    expect(rest.hidden).toBe(true)
    expect(block.textContent!.slice(0, block.textContent!.length - rest.textContent!.length).split('\n')).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'])
    expect(rest.textContent!.startsWith('\nline 7')).toBe(true)
    // a word only in the output: counted; going to it opens the turn (onOpen told) and then its output's lines past the sixth
    await type('osprey')
    expect([w.search.count, w.search.at]).toEqual([1, 0])
    expect(w.opened).toEqual(['s.jsonl#L1'])
    const out = () => doc().querySelector('[data-anchor="s.jsonl#L1"] .thimble-turn-result')!
    expect(out().querySelector<HTMLElement>('[data-thimble-fold]')!.hidden).toBe(false)
    expect(out().nextElementSibling!.textContent).toBe('Show less')
    // the word on line 15: counted, shown; Show less folds it again, still counted
    await type('kestrel')
    expect(w.search.count).toBe(1)
    const more = () => doc().querySelector<HTMLElement>('[data-anchor="s.jsonl#L2"] .thimble-turn-more')!
    const restNow = () => doc().querySelector<HTMLElement>('[data-anchor="s.jsonl#L2"] [data-thimble-fold]')!
    expect([restNow().hidden, more().textContent]).toEqual([false, 'Show less'])
    more().click()
    await wait(60)
    expect([restNow().hidden, more().textContent, w.search.count]).toEqual([true, 'Show more', 1])
  })

  test("a record keeps its folded values, a long string's rest and a long list's items past its first 100 in the page, hidden, to a cap; going to a match opens every level around it", async () => {
    await load(`<div class="top"><span id="search"></span></div><div id="rec"></div>`)
    const w = win()
    w.REC = {
      deep: { a: { b: { c: { d: 'a heron' } } } },
      notes: Array.from({ length: 20 }, (_, i) => (i === 11 ? 'a plover' : `line ${i + 1}`)).join('\n'),
      steps: Array.from({ length: 150 }, (_, i) => (i === 140 ? 'lapwing' : `step ${i}`)),
      big: { a: { x: 'x'.repeat(150000), y: 'y'.repeat(60000) + ' curlew' } },
    }
    w.eval(`
      thimble.record({ mount: '#rec', value: window.REC, ref: 'r.jsonl#L1' })
      window.search = thimble.search({ mount: '#search', in: '#rec' })
    `)
    // a folded value's values, each on its own line (its keys are the tree's wording), a long string's text past its
    // sixth line, a long list's items past its first 100
    const fold = (sel: string) => doc().querySelector<HTMLElement>(sel)!
    expect([fold('[data-fold-path="/deep/a"]').hidden, fold('[data-fold-path="/deep/a"]').hasAttribute('data-thimble-fold'), fold('[data-fold-path="/deep/a"]').textContent]).toEqual([true, true, 'a heron'])
    expect([fold('[data-fold-long="/notes"]').hidden, fold('[data-fold-long="/notes"]').textContent!.startsWith('\nline 7')]).toEqual([true, true])
    expect([fold('[data-fold-more="/steps"]').hidden, fold('[data-fold-more="/steps"]').textContent!.split('\n').slice(0, 2)]).toEqual([true, ['step 100', 'step 101']])
    // the record's folds hold 200,000 characters at most: a word past them is not found
    expect(fold('[data-fold-path="/big/a"]').textContent!.length).toBeLessThanOrEqual(200000)
    await type('curlew')
    expect(w.search.count).toBe(0)
    // a word four levels under an open one: going to it opens each level in turn, until it shows
    await type('heron')
    expect([w.search.count, w.search.at]).toEqual([1, 0])
    expect(doc().querySelector('[data-fold="/deep/a/b/c"]')!.getAttribute('aria-expanded')).toBe('true')
    const hit = [...doc().querySelectorAll('#rec .thimble-record-val')].find((e) => e.textContent === 'a heron')
    expect(hit && !hit.closest('[data-thimble-fold][hidden]')).toBe(true)
    // the items past the first 100, and a long string's lines past the sixth
    await type('lapwing')
    expect([w.search.count, doc().querySelector('[data-more="/steps"]')]).toEqual([1, null])
    await type('plover')
    expect([w.search.count, fold('[data-fold-long="/notes"]').hidden, texts('[data-long="/notes"]')]).toEqual([1, false, ['Show less']])
  })

  test("a block cut to six lines by its height opens when the event is sent to the block itself, as the search sends it for a match the height cuts from view", async () => {
    await load(`<div id="turns"></div><div id="rec"></div>`)
    const w = win()
    w.LONG = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n')
    w.eval(`
      window.tr = thimble.transcript({ mount: '#turns' })
      tr.draw([{ ref: 's.jsonl#L1', speaker: 'lead', kind: 'text', text: window.LONG }])
      thimble.record({ mount: '#rec', value: { notes: window.LONG }, ref: 'r.jsonl#L1' })
    `)
    const unfold = (sel: string) => doc().querySelector(sel)!.dispatchEvent(new w.CustomEvent('thimble-unfold', { bubbles: true }))
    unfold('#turns .thimble-turn-block')
    expect([doc().querySelector<HTMLElement>('#turns [data-thimble-fold]')!.hidden, texts('#turns .thimble-turn-more')]).toEqual([false, ['Show less']])
    unfold('#rec .thimble-record-text')
    expect([doc().querySelector<HTMLElement>('#rec [data-fold-long="/notes"]')!.hidden, texts('[data-long="/notes"]')]).toEqual([false, ['Show less']])
  })

  test("a quote a citation opens in folded text: its fold opens, as the search's match does, and the quote is found", async () => {
    await load(`<div id="rec"></div>`)
    const w = win()
    w.eval(`thimble.record({ mount: '#rec', value: { deep: { a: { b: { c: 'the heron by the weir' } } } }, ref: 'r.jsonl#L1' })`)
    expect(doc().querySelector('[data-fold="/deep/a"]')!.getAttribute('aria-expanded')).toBe('false')
    w.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'thimble:open', open: { ref: 'r.jsonl#L1' }, quote: { record: 'r.jsonl#L1', text: 'heron by the weir' } }, source: w.parent as any }))
    await wait(150)
    expect(of('quoted')).toEqual([{ type: 'thimble:quoted', found: true }])
    expect(doc().querySelector('[data-fold="/deep/a/b"]')!.getAttribute('aria-expanded')).toBe('true')
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

  test("hunks alone, as a forge gives one file's patch: no head; a long hunk folds its unchanged stretch; set() turns between a patch and two texts", async () => {
    await load(`<div id="d"></div>`)
    const w = win()
    const hunk = ['@@ -10,12 +10,12 @@ def run():', '     a = 1', ...Array.from({ length: 9 }, (_, i) => `     x${i} = ${i}`), '-    return a', '+    return a + 1', '     # end'].join('\n')
    w.eval(`window.diff = thimble.diff({ mount: '#d', patch: ${JSON.stringify(hunk)} })`)
    expect(doc().querySelectorAll('.thimble-diff-file')).toHaveLength(0)
    expect(texts('.thimble-diff-hunk')).toEqual(['@@ -10,12 +10,12 @@ def run():'])
    // the 7 lines more than 3 from the change fold, numbered from the hunk's line
    expect(texts('.thimble-diff-gap .thimble-diff-n')).toEqual(['7 unchanged lines'])
    const fold = doc().querySelector('[data-thimble-fold]') as HTMLElement
    expect(fold.hidden).toBe(true)
    expect(fold.querySelector('.thimble-diff-no')!.getAttribute('data-n')).toBe('10')
    fold.dispatchEvent(new dom.window.CustomEvent('thimble-unfold', { bubbles: true }))
    expect(fold.hidden).toBe(false)
    // a patch that only adds lines is inline wherever it is
    w.diff.set({ patch: '@@ -0,0 +1 @@\n+only' })
    expect(w.diff.mode).toBe('inline')
    expect([w.diff.added, w.diff.removed]).toEqual([1, 0])
    // two texts in place of the patch, and a patch with no hunk
    w.diff.set({ before: 'a', after: 'b' })
    expect(doc().querySelectorAll('.thimble-diff-hunk')).toHaveLength(0)
    expect([w.diff.added, w.diff.removed]).toEqual([1, 1])
    w.diff.set({ patch: 'not a patch' })
    expect(texts('.thimble-diff-empty')).toEqual(['No changes in the patch'])
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
  /** the text that shows: the element's text with its folded parts left out */
  const shown = (root: Element) => {
    const copy = root.cloneNode(true) as Element
    copy.querySelectorAll('[hidden], .thimble-text-more').forEach((e) => e.remove())
    return copy.textContent ?? ''
  }

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

  test('the fold: html() folds a text past 12 lines, a mount draws it whole; Show more, the search and a quote open it', async () => {
    await loadText('<div id="t"></div><div id="m"></div>')
    const w = win()
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const text = lines.join('\n')
    const root = drawn(w.thimble.text.html(text, { format: 'plain', ref: 'mail.jsonl#L1' }))
    expect(shown(root).trim()).toBe(lines.slice(0, 12).join('\n'))
    expect(root.textContent).toContain('line 20')
    const more = root.querySelector('.thimble-text-more') as HTMLElement
    expect([more.textContent, more.getAttribute('aria-expanded'), more.hasAttribute('data-thimble-chrome')]).toEqual(['Show more', 'false', true])
    const parts = [...root.querySelectorAll('.thimble-text-fold')]
    expect(parts.length).toBeGreaterThan(0)
    expect(parts.every((p) => (p as HTMLElement).hidden && p.hasAttribute('data-thimble-fold'))).toBe(true)
    // a click opens it, and folds it again
    more.click()
    expect([more.textContent, shown(root).trim()]).toEqual(['Show less', text])
    more.click()
    expect(shown(root).trim()).toBe(lines.slice(0, 12).join('\n'))
    // the search, or a quote, sends a part the event that opens the fold
    parts[parts.length - 1].dispatchEvent(new dom.window.CustomEvent('thimble-unfold', { bubbles: true }))
    expect(shown(root).trim()).toBe(text)
    // markdown: a list folds after its 12th line, its items kept in place so its numbers run on
    const md = drawn(w.thimble.text.html(lines.map((l, i) => `${i + 1}. ${l}`).join('\n'), { fold: 5 }))
    expect(md.querySelectorAll('ol').length).toBe(1)
    expect([...md.querySelectorAll('li')].map((li) => (li as HTMLElement).hidden)).toEqual(lines.map((_, i) => i >= 5))
    // a mount draws it whole unless asked; fold 0 never folds; a rest under 4 lines shows; a long line counts as it wraps
    w.thimble.text('#m', text)
    expect(doc().querySelector('#m .thimble-text-more')).toBeNull()
    expect(w.thimble.text('#m', text, { fold: 6 }).querySelector('.thimble-text-more')).not.toBeNull()
    expect(drawn(w.thimble.text.html(text, { fold: 0 })).querySelector('.thimble-text-more')).toBeNull()
    expect(drawn(w.thimble.text.html(lines.slice(0, 15).join('\n'), { format: 'plain' })).querySelector('.thimble-text-more')).toBeNull()
    const long = drawn(w.thimble.text.html(Array.from({ length: 300 }, (_, i) => `word${i}`).join(' '), { format: 'plain', fold: 2 }))
    expect(shown(long).length).toBeGreaterThan(150)
    expect(shown(long).length).toBeLessThan(260)
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
    expect(texts('.thimble-msg-day')).toEqual(['Thu 27 Aug 2026', 'Fri 28 Aug 2026'])
    expect(doc().querySelector('[data-anchor="m#10"]')!.previousElementSibling!.className).toBe('thimble-msg-day')
    expect(texts('.thimble-msg-header')).toEqual(['# ferries11 messages · 1 event'])
    expect([...doc().querySelectorAll('.thimble-msg-header, .thimble-msg-day, .thimble-msg-head')].every((e) => e.hasAttribute('data-thimble-chrome'))).toBe(true)
  })

  test("replies: under the group their parent's head starts, one level in however deep, sharing a head by the same rule", async () => {
    await load('<div id="c"></div>')
    const w = win()
    w.eval('window.conv = thimble.messages({ mount: "#c" })')
    w.conv.draw([
      { ref: 'r#1', t: T, author: 'eve', text: 'a question' },
      { ref: 'r#2', t: T + 20, author: 'eve', text: 'and its detail' },
      { ref: 'r#3', t: T + 30, author: 'gus', text: 'something else' },
      { ref: 'r#4', t: T + 40, author: 'fay', parent: 'r#1', text: 'an answer' },
      { ref: 'r#5', t: T + 50, author: 'fay', parent: 'r#1', text: 'a second answer' },
      { ref: 'r#6', t: T + 60, author: 'fay', parent: 'r#4', text: 'a reply to the answer' },
      { ref: 'r#7', t: T + 70, author: 'hal', parent: 'r#3', text: 'a reply to gus' },
    ])
    expect(heads()).toEqual([
      ['r#1', 'head', ''], ['r#2', 'same head', ''], ['r#4', 'head', 'reply'], ['r#5', 'same head', 'reply'],
      ['r#6', 'head', 'reply'], ['r#3', 'head', ''], ['r#7', 'head', 'reply'],
    ])
    // the messages as given, whatever order they are drawn in
    expect(w.conv.messages.map((m: { ref: string }) => m.ref)).toEqual(['r#1', 'r#2', 'r#3', 'r#4', 'r#5', 'r#6', 'r#7'])
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

  test('alone with no ref or time: drawn, a head shared, no anchor; nothing to draw says so; made again on its mount, the one before retires', async () => {
    await load('<div id="c"></div>')
    const w = win()
    w.eval('window.conv = thimble.messages({ mount: "#c" })')
    w.conv.draw([{ author: 'ana', text: 'hello' }, { author: 'ana', text: 'again' }, null, 'nonsense'])
    expect(heads()).toEqual([[null, 'head', ''], [null, 'same head', '']])
    expect(texts('.thimble-msg-day')).toEqual([])
    w.conv.draw([], { empty: 'No posts in this thread' })
    expect(texts('.thimble-msg-none')).toEqual(['No posts in this thread'])
    w.eval('window.again = thimble.messages({ mount: "#c" })')
    w.conv.draw([{ ref: 'a#1', author: 'old', text: 'from the one before' }])
    expect(texts('.thimble-msg-none')).toEqual(['No posts in this thread'])
    w.again.draw([{ ref: 'a#1', author: 'new', text: 'drawn' }])
    expect(texts('.thimble-msg-author')).toEqual(['new'])
  })

  test('a loop of parents draws every message of it; an event with no author says what happened alone', async () => {
    await load('<div id="c"></div>')
    const w = win()
    w.eval('window.conv = thimble.messages({ mount: "#c" })')
    w.conv.draw([
      { ref: 'l#1', t: T, author: 'ana', parent: 'l#2', text: 'a reply to the next' },
      { ref: 'l#2', t: T + 60, author: 'bo', parent: 'l#1', text: 'a reply to the one before' },
      { ref: 'l#3', t: T + 90, author: 'cy', parent: 'l#3', text: 'a reply to itself' },
      { ref: 'l#4', t: T + 120, kind: 'event', icon: 'delete', said: 'Branch deleted' },
    ])
    // the loop's first message given stands as its root, the other under it
    expect(heads()).toEqual([['l#1', 'head', ''], ['l#2', 'head', 'reply'], ['l#3', 'head', ''], ['l#4', 'head', '']])
    expect(texts('[data-anchor="l#4"] .thimble-msg-said')).toEqual(['Branch deleted'])
    expect(doc().querySelector('[data-anchor="l#4"]')!.getAttribute('data-anchor-text')).toBe('Branch deleted')
  })

  test('a pick marks the message chosen, kept when drawn again; ↑ and ↓ go to the message above or below; mentions reach thimble.text', async () => {
    await load('<div id="c"></div>')
    const w = win()
    w.picked = []
    w.given = []
    // thimble.text is its own part: here a stand-in that keeps what it was given
    w.eval('thimble.text = (el, text, o) => { window.given.push(o); el.textContent = text; return el }')
    w.eval('window.conv = thimble.messages({ mount: "#c", mentions: [{ match: /#(\\d+)/g, ref: (m) => "view:forge/pull/" + m[1] }], onPick: (m) => window.picked.push(m.ref) })')
    const list = [
      { ref: 'k#1', t: T, author: 'ana', text: 'see #12' },
      { ref: 'k#2', t: T + 600, author: 'bo', text: 'two' },
      { ref: 'k#3', t: T + 1200, author: 'cy', text: 'three' },
    ]
    w.conv.draw(list)
    expect(w.given.map((o: { format: string; mentions: unknown[] }) => [o.format, o.mentions.length])).toEqual([['markdown', 1], ['markdown', 1], ['markdown', 1]])
    const at = (ref: string) => doc().querySelector(`[data-anchor="${ref}"]`) as HTMLElement
    at('k#1').focus()
    key(at('k#1'), 'ArrowDown')
    expect(doc().activeElement!.getAttribute('data-anchor')).toBe('k#2')
    key(at('k#2'), 'ArrowDown')
    key(at('k#3'), 'ArrowDown')
    expect(doc().activeElement!.getAttribute('data-anchor')).toBe('k#3')
    key(at('k#3'), 'ArrowUp')
    key(at('k#2'), ' ')
    expect(w.picked).toEqual(['k#2'])
    expect([...doc().querySelectorAll('.thimble-msg.active')].map((e) => e.getAttribute('data-anchor'))).toEqual(['k#2'])
    w.conv.draw(list.slice().reverse())
    expect([...doc().querySelectorAll('.thimble-msg.active')].map((e) => e.getAttribute('data-anchor'))).toEqual(['k#2'])
  })

  test('with the side panel: a pick opens it and marks the message; Reset closes it and leaves no message chosen', async () => {
    await load('<div class="top"><span id="colour"></span></div><div id="body"><div id="c"></div></div>')
    const w = win()
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'author', title: 'Author' }] })
      window.side = thimble.side({ mount: '#body' })
      window.conv = thimble.messages({ mount: '#c', onPick: (m) => side.open({ title: m.author, ref: m.ref, html: m.text }) })
    `)
    w.conv.draw([{ ref: 'p#1', t: T, author: 'ana', text: 'one' }, { ref: 'p#2', t: T + 600, author: 'bo', text: 'two' }])
    ;(doc().querySelector('[data-anchor="p#2"]') as HTMLElement).click()
    expect([w.side.ref, [...doc().querySelectorAll('.thimble-msg.active')].map((e) => e.getAttribute('data-anchor'))]).toEqual(['p#2', ['p#2']])
    await wait()
    const reset = doc().querySelector('.thimble-reset') as HTMLButtonElement
    expect(reset.hidden).toBe(false)
    reset.click()
    await wait()
    expect([w.side.isOpen, doc().querySelector('.thimble-msg.active')]).toEqual([false, null])
  })

  test('set: a new `to` draws the message after it again, which then names its own', async () => {
    await load('<div id="c"></div>')
    const w = win()
    w.eval('window.conv = thimble.messages({ mount: "#c", format: "plain" })')
    w.conv.draw([
      { ref: 's#1', t: T, author: 'ana', to: 'bo', text: 'one' },
      { ref: 's#2', t: T + 30, author: 'ana', to: 'bo', text: 'two, to the same' },
    ])
    expect(texts('.thimble-msg-to')).toEqual(['to bo'])
    w.conv.set('s#1', { to: 'cy' })
    expect(texts('.thimble-msg-to')).toEqual(['to cy', 'to bo'])
  })
})
