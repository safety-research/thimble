// The view kit's record viewer (backend/app/viewer_record.js, thimble.record) and charts (viewer_chart.js,
// thimble.chart) in a jsdom window of their own with the bridge and the kit's other parts, as views.frame_document loads
// them. A record is a tree under its citation: its fields as rows, a nested value folded past `open` levels behind its
// key with its size and first fields, a long string folded with Show more and Show less, a long list's first items with
// Show N more, JSON text drawn as what it holds; the record is anchored with its ref and its citation opens it in the
// File browser; `find` highlights its matches and opens what holds them; called again with the same ref it keeps what
// was opened, with another it starts afresh. A chart asks thimble for its spec with the kit's own fetch, with
// thimble.chart's options and none of the kit's own, and asks once for the same chart; it draws the answer with the
// canvas's drawing (here a stand-in, since jsdom draws no Vega: tests/public/browser/view-chart.test.ts draws it),
// its groups in Color by's colours with no legend and a label's classes in the label's colours; it says what is wrong
// in its place, and a chart of no rows asks nothing. Each works on a plain element with no other part mounted.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'
import { refLabel } from '../../src/lib/refs'

const APP = path.resolve(__dirname, '../../../backend/app')
const read = (n: string) => readFileSync(path.join(APP, n), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
// the kit as views.frame_document loads it, with a stand-in for the canvas's chart drawing (frontend lib/kitChart)
const DRAWING = `window.__drawn = []; window.__thimbleCharts = {
  draw: function (el, spec, opts) { var d = { view: { addEventListener: function (t, fn) { window.__click = fn } }, finalize: function () { d.gone = true }, container: true }; opts.replace(); opts.drawn(d); window.__drawn.push({ el: el, spec: spec, opts: opts, d: d }); el.innerHTML = '<svg></svg>'; return Promise.resolve(d) },
  refit: function () { return true } }`
const KIT =
  script(read('viewer_bridge.js')) +
  script(`window.__thimbleLabelOrder = ${read('label_order.json')}`) +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_record.js'].map((n) => script(read(n))).join('') +
  script(DRAWING) +
  ['viewer_chart.js', 'viewer_range.js'].map((n) => script(read(n))).join('')
const TOKENS = '<style>:root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93}</style>'

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any; [k: string]: any }
const doc = () => dom.window.document
const fromPage = (data: object) => win().dispatchEvent(new dom.window.MessageEvent('message', { data, source: win().parent as any }))
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)
const texts = (sel: string, root: ParentNode = doc()) => [...root.querySelectorAll(sel)].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
const click = (el: Element | null) => el!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))

async function load(body = '<div id="rec"></div><div id="c"></div><span id="colour"></span>') {
  dom = new JSDOM(`<!doctype html><html><head>${TOKENS}${KIT}</head><body>${body}</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  sent = []
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 })
  await wait()
}
afterEach(() => dom?.window.close())

const REC = {
  type: 'tool_use',
  tool: 'Read',
  turns: 4,
  ok: false,
  note: null,
  blank: '',
  input: { file_path: '/repo/pandas/core/frame.py', options: { recursive: true, globs: ['*.py', '*.pyi'] } },
  output: Array.from({ length: 12 }, (_, i) => `line ${i + 1} of what came back`).join('\n'),
  tags: ['perf', 'docs'],
  steps: Array.from({ length: 150 }, (_, i) => i),
}

describe('thimble.record', () => {
  test('draws a record as its fields under its citation, nested values past `open` folded with their size and first fields', async () => {
    await load()
    const got = win().thimble.record({ mount: '#rec', value: REC, ref: 'runs/r1/explorer.jsonl#L12' })
    expect(got).toEqual({ hits: 0 })
    const root = doc().querySelector('#rec .thimble-record')!
    expect(root.getAttribute('data-anchor')).toBe('runs/r1/explorer.jsonl#L12')
    expect(texts('.thimble-record-cite .chip-text')).toEqual(['r1 › explorer.jsonl L12'])
    expect(doc().querySelector('.thimble-record-cite .chip')!.getAttribute('title')).toBe('runs/r1/explorer.jsonl#L12')
    const top = doc().querySelector('#rec .thimble-record-tree')!
    const keys = [...top.children].filter((r) => r.classList.contains('thimble-record-row')).map((r) => texts('.thimble-record-key', r)[0])
    expect(keys).toEqual(['type', 'tool', 'turns', 'ok', 'note', 'blank', 'input', 'output', 'tags', 'steps'])
    // plain values: text as it is, numbers, booleans and null in mono, an empty string as ""
    expect(texts('.thimble-record-val.is-num')).toContain('4')
    expect(texts('.thimble-record-val.is-bool')).toEqual(['false'])
    expect(texts('.thimble-record-val.is-null')).toEqual(['null'])
    expect(texts('.thimble-record-val.is-empty')).toContain('""')
    // the record's fields open at first and one level under them; deeper ones folded to their size and first fields
    expect(texts('[data-fold="/input"] + .thimble-record-sum')).toEqual(['2 fields'])
    expect(doc().querySelector('[data-fold="/input/options"]')!.getAttribute('aria-expanded')).toBe('false')
    expect(texts('[data-fold="/input/options"] + .thimble-record-sum')).toEqual(['2 fields: recursive, globs'])
    click(doc().querySelector('[data-fold="/input/options"]'))
    expect(doc().querySelector('[data-fold="/input/options"]')!.getAttribute('aria-expanded')).toBe('true')
    expect(texts('[data-fold="/input/options/globs"] + .thimble-record-sum')).toEqual(['2 items: *.py, *.pyi'])
    expect(doc().activeElement?.getAttribute('data-fold')).toBe('/input/options')
    click(doc().querySelector('[data-fold="/input"]'))
    expect(doc().querySelector('[data-fold="/input/options"]')).toBeNull()
  })

  test('folds a long string with Show more and a long list with Show N more, and opens the record in the File browser', async () => {
    await load()
    win().thimble.record({ mount: '#rec', value: REC, ref: 'r1/explorer.jsonl#L12' })
    const more = () => doc().querySelector('[data-long="/output"]')!
    expect(more().textContent).toBe('Show more12 lines')
    // a long string on few lines says its characters
    win().thimble.record({ mount: '#c', value: { essay: 'word '.repeat(200) }, ref: 'r1/essay.jsonl#L1' })
    expect(texts('#c [data-long="/essay"]')).toEqual(['Show more1,000 characters'])
    expect(doc().querySelector('.thimble-record-text')!.classList.contains('is-folded')).toBe(true)
    click(more())
    expect(more().textContent).toBe('Show less')
    expect(doc().querySelector('.thimble-record-text')!.classList.contains('is-folded')).toBe(false)
    // the list's items, the rows of the box under its key
    const steps = () => [...doc().querySelector('[data-fold="/steps"]')!.parentElement!.nextElementSibling!.children].filter((r) => r.querySelector('.thimble-record-val'))
    expect(steps().length).toBe(100)
    expect(texts('[data-more="/steps"]')).toEqual(['Show 50 more'])
    click(doc().querySelector('[data-more="/steps"]'))
    expect(texts('[data-more="/steps"]')).toEqual([])
    expect(steps().length).toBe(150)
    click(doc().querySelector('[data-record-file]'))
    expect(of('navigate')).toEqual([{ type: 'thimble:navigate', ref: 'r1/explorer.jsonl#L12', browser: true }])
  })

  test('finds words: highlights them and opens what holds them; the same ref keeps what was opened, another starts afresh', async () => {
    await load()
    let got = win().thimble.record({ mount: '#rec', value: REC, ref: 'a.jsonl#L1', find: 'PYI' })
    expect(got.hits).toBe(1)
    expect(texts('mark.thimble-record-hit')).toEqual(['pyi'])
    expect(doc().querySelector('[data-fold="/input/options"]')!.getAttribute('aria-expanded')).toBe('true')
    got = win().thimble.record({ mount: '#rec', value: REC, ref: 'a.jsonl#L1', find: 'line 12' })
    expect(got.hits).toBe(1)
    expect(doc().querySelector('.thimble-record-text')!.classList.contains('is-folded')).toBe(false)
    // folded by hand, kept while the record is the same
    click(doc().querySelector('[data-fold="/tags"]'))
    win().thimble.record({ mount: '#rec', value: REC, ref: 'a.jsonl#L1' })
    expect(doc().querySelector('[data-fold="/tags"]')!.getAttribute('aria-expanded')).toBe('false')
    win().thimble.record({ mount: '#rec', value: REC, ref: 'a.jsonl#L2' })
    expect(doc().querySelector('[data-fold="/tags"]')!.getAttribute('aria-expanded')).toBe('true')
  })

  test('draws JSON text as what it holds, a plain value alone, and with `open` 1 folds every nested value', async () => {
    await load()
    win().thimble.record({ mount: '#rec', value: JSON.stringify({ a: 1, b: { c: 2 } }) + '\n', ref: 'x.jsonl#L3', open: 1 })
    expect(texts('#rec .thimble-record-tree > .thimble-record-row .thimble-record-key')).toEqual(['a', 'b'])
    expect(doc().querySelector('[data-fold="/b"]')!.getAttribute('aria-expanded')).toBe('false')
    win().thimble.record({ mount: '#rec', value: 'not { json', ref: 'x.jsonl#L4' })
    expect(texts('#rec .thimble-record-val')).toEqual(['not { json'])
    win().thimble.record({ mount: '#rec', value: { a: 1 } })
    expect(doc().querySelector('#rec .thimble-record')!.hasAttribute('data-anchor')).toBe(false)
    expect(doc().querySelector('#rec .thimble-record-cite')).toBeNull()
  })

  test("names its citation as thimble's chips do", async () => {
    await load()
    const refs = ['runs/r1/explorer.jsonl#L12', 'runs/team-6/agents/a.jsonl#L3-L9', 'a/b/c/trial-03/x/y/notes.jsonl#L5.b2', 'deploys.csv#row=3',
      'chat/ops.json#/messages/12', 'papers/x.pdf#p4', 'logs/run.db#calls/41', 'top.jsonl#L1', 'view:board/INC-311', 'src/app.py#parse_args', 'README.md']
    for (const ref of refs) {
      win().thimble.record({ mount: '#rec', value: { a: 1 }, ref })
      expect(texts('#rec .thimble-record-cite .chip-text')[0], ref).toBe(refLabel(ref))
    }
  })

  test('draws in the side panel as its body, and takes Color by\'s bar', async () => {
    await load('<span id="colour"></span><div id="body"><div id="list"></div></div>')
    const colour = win().thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }] })
    const side = win().thimble.side({ mount: '#body' })
    side.open({ title: 'Read', ref: 'a.jsonl#L1', render: (body: HTMLElement) => win().thimble.record({ mount: body, value: REC, ref: 'a.jsonl#L1', colour }) })
    const rec = side.body.querySelector('.thimble-record')!
    expect(rec.getAttribute('data-anchor')).toBe('a.jsonl#L1')
    expect(rec.getAttribute('data-colour')).toBe('Read')
    // the panel's next body, the page's own, is the page's: a click in it draws no record
    side.open({ title: 'Other', html: '<button id="mine" data-more="/steps">mine</button>' })
    click(side.body.querySelector('#mine'))
    expect(side.body.querySelector('.thimble-record')).toBeNull()
    expect(side.body.querySelector('#mine')).not.toBeNull()
  })
})

describe('thimble.chart', () => {
  // answers the kit's chart fetches as thimble would, here with a spec of its own
  const answer = (spec: object | null, extra: object = {}) => {
    const q = of('fetch').at(-1)!
    fromPage({ type: 'thimble:result', id: q.id, data: spec ? { spec, n: 2, ...extra } : { error: "thimble.chart('bar') takes (category, value) or (category, value, group) columns, in that order; got 1: a" } })
  }
  const BAR = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: [{ agent: 'agent-1', posts: 3, tool: 'Read' }, { agent: 'agent-2', posts: 9, tool: 'Bash' }] },
    mark: 'bar',
    encoding: { y: { field: 'agent', type: 'nominal', sort: ['agent-2', 'agent-1'] }, x: { field: 'posts', type: 'quantitative' }, color: { field: 'tool', type: 'nominal', title: 'tool', sort: ['Bash', 'Read'] } },
  }
  const ROWS = [{ agent: 'agent-1', posts: 3, tool: 'Read' }, { agent: 'agent-2', posts: 9, tool: 'Bash' }]

  test("asks thimble for thimble.chart's spec with the kit's own fetch, once for the same chart, and draws it", async () => {
    await load()
    const picked: object[] = []
    const done = win().thimble.chart('#c', 'bar', ROWS, { stack: false, height: 120, onPick: (row: object) => picked.push(row) })
    expect(of('fetch').map((m) => m.query)).toEqual([{ $thimble: 'chart', kind: 'bar', rows: ROWS, options: { stack: false } }])
    answer(BAR)
    const view = await done
    expect(view).toBe(win().__drawn[0].d.view)
    const drawn = win().__drawn[0]
    expect(drawn.el.className).toBe('thimble-chart-plot')
    expect(drawn.spec.height).toBe(120)
    expect(drawn.spec.encoding.color.scale).toBeUndefined()
    // a mark clicked: its row, by the columns the chart's rows hold
    win().__click({}, { datum: { agent: 'agent-2', posts: 9, tool: 'Bash', posts_end: 9, __thimble_stack: 1 } })
    expect(picked).toEqual([{ agent: 'agent-2', posts: 9, tool: 'Bash' }])
    // the same chart again asks nothing and keeps the one drawn, a click going to the new call's onPick
    const again: object[] = []
    expect(await win().thimble.chart('#c', 'bar', ROWS, { stack: false, height: 120, onPick: (row: object) => again.push(row) })).toBe(view)
    expect(of('fetch').length).toBe(1)
    expect(win().__drawn.length).toBe(1)
    win().__click({}, { datum: { agent: 'agent-1', posts: 3, tool: 'Read' } })
    expect(again).toEqual([{ agent: 'agent-1', posts: 3, tool: 'Read' }])
    expect(picked.length).toBe(1)
    // the same rows drawn otherwise ask nothing and replace it
    await win().thimble.chart('#c', 'bar', ROWS, { stack: false, height: 90 })
    expect(of('fetch').length).toBe(1)
    expect(win().__drawn.length).toBe(2)
    expect(win().__drawn[0].d.gone).toBe(true)
    expect(win().__drawn[1].spec.height).toBe(90)
    expect(doc().querySelector('#c')!.hasAttribute('data-pick')).toBe(false)
  })

  test('asks one call at a time for a mount: the calls made while it waits ask nothing but the latest', async () => {
    await load()
    const rowsOf = (n: number) => [{ agent: 'agent-1', posts: n }]
    const first = win().thimble.chart('#c', 'bar', rowsOf(1))
    const second = win().thimble.chart('#c', 'bar', rowsOf(2))
    const third = win().thimble.chart('#c', 'bar', rowsOf(3))
    await wait()
    expect(of('fetch').map((m) => (m.query as { rows: unknown }).rows)).toEqual([rowsOf(1)])
    answer(BAR)
    await wait()
    expect(of('fetch').map((m) => (m.query as { rows: unknown }).rows)).toEqual([rowsOf(1), rowsOf(3)])
    answer(BAR)
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(await third).toBe(win().__drawn.at(-1).d.view)
    expect(win().__drawn.length).toBe(1)
    // another mount asks for itself
    win().thimble.chart('#rec', 'bar', rowsOf(4))
    await wait()
    expect(of('fetch').length).toBe(3)
  })

  test("draws the groups in Color by's colours with no legend, gray for a value turned off, and a label in its colours", async () => {
    await load()
    const colour = win().thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool', values: ['Read', 'Bash'] }] })
    const done = win().thimble.chart('#c', 'bar', ROWS, { colour })
    expect(of('fetch').at(-1)!.query).toEqual({ $thimble: 'chart', kind: 'bar', rows: ROWS, options: {} })
    answer(BAR)
    await done
    const color = win().__drawn.at(-1).spec.encoding.color
    expect(color.legend).toBeNull()
    expect(color.scale.domain).toEqual(['Bash', 'Read'])
    expect(color.scale.range).toEqual([colour.colourOf('Bash'), colour.colourOf('Read')])
    expect(new Set(color.scale.range).size).toBe(2)
    // a value the spec's order leaves out takes its own colour after it, and the rows with no value the gray, last
    const more = [...ROWS, { agent: 'agent-3', posts: 1, tool: 'Grep' }, { agent: 'agent-3', posts: 2, tool: null }]
    const both = win().thimble.chart('#c', 'bar', more, { colour })
    await wait() // a mount's later calls ask once the call before has its answer
    answer({ ...BAR, data: { values: more } })
    await both
    const scale = win().__drawn.at(-1).spec.encoding.color.scale
    expect(scale.domain).toEqual(['Bash', 'Read', 'Grep', null])
    expect(scale.range).toEqual([colour.colourOf('Bash'), colour.colourOf('Read'), colour.colourOf('Grep') || 'var(--label-none)', 'var(--label-none)'])
    // Read's colour turned off in the top row: its bars gray, as its records are
    const read = [...doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')].find((c) => c.textContent!.startsWith('Read'))!
    read.click()
    await win().thimble.chart('#c', 'bar', ROWS, { colour })
    expect(win().__drawn.at(-1).spec.encoding.color.scale.range).toEqual([colour.colourOf('Bash'), 'var(--label-none)'])
    const labelled = win().thimble.chart('#c', 'bar', [{ activity: 'money', n: 2 }], { label: 'activity type' })
    await wait()
    expect(of('fetch').at(-1)!.query).toMatchObject({ options: { label: 'activity type' } })
    answer({ ...BAR, encoding: { ...BAR.encoding, color: undefined } }, { label: [['captcha', 1], ['money', 3], ['other', 0]] })
    await labelled
    // each class in its place of the label palette, the gray for the negative one (jsdom leaves the tokens unresolved;
    // the browser test reads the colours)
    expect(win().__drawn.at(-1).opts.labels).toEqual([[
      { name: 'captcha', colour: 'var(--label-1)', none: false },
      { name: 'money', colour: 'var(--label-3)', none: false },
      { name: 'other', colour: 'var(--label-none)', none: true },
    ]])
  })

  test('says what is wrong in its place, draws nothing for no rows, and draws any Vega-Lite spec given', async () => {
    await load()
    const failing = win().thimble.chart('#c', 'bar', [{ a: 'x' }])
    answer(null)
    expect(await failing).toBeNull()
    expect(texts('#c .thimble-chart-note.is-error')).toEqual(["Chart failed: thimble.chart('bar') takes (category, value) or (category, value, group) columns, in that order; got 1: a"])
    expect(of('error').at(-1)!.message).toContain("thimble.chart('bar') takes")
    const asked = of('fetch').length
    expect(await win().thimble.chart('#c', 'line', [])).toBeNull()
    expect(of('fetch').length).toBe(asked)
    expect(texts('#c .thimble-chart-note')).toEqual(['No data'])
    expect(doc().querySelector<HTMLElement>('#c .thimble-chart-note')!.classList.contains('is-error')).toBe(false)
    await win().thimble.chart('#c', BAR, { height: 90 })
    expect(of('fetch').length).toBe(asked)
    expect(win().__drawn.at(-1).spec).toMatchObject({ mark: 'bar', height: 90 })
    expect(doc().querySelector<HTMLElement>('#c .thimble-chart-note')!.hidden).toBe(true)
    // rows that are no JSON say so in the chart's place too
    const loop: Record<string, unknown> = { a: 'x' }
    loop.self = loop
    expect(await win().thimble.chart('#rec', 'bar', [loop])).toBeNull()
    expect(texts('#rec .thimble-chart-note.is-error')[0]).toMatch(/^Chart failed: thimble\.chart: .*circular/i)
    // a spec written by hand with no schema is drawn as Vega-Lite, so it is fitted to its box as the others are
    const { $schema: _schema, ...bare } = BAR
    await win().thimble.chart('#c', bare)
    expect(win().__drawn.at(-1).spec.$schema).toBe(BAR.$schema)
  })
})
