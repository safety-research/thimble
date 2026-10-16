// The view kit's record viewer (backend/app/viewer_record.js, thimble.record) and charts (viewer_chart.js,
// thimble.chart) in a jsdom window of their own with the bridge and the kit's other parts, as views.frame_document loads
// them. A record is a tree under its citation, its nested values past `open` folded with their size and first fields;
// a chart says what is wrong in its place, draws nothing for no rows, and draws any Vega-Lite spec given (with a
// stand-in for the canvas's drawing, since jsdom draws no Vega).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

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
    await win().thimble.chart('#c', BAR, { height: 60 })
    expect(of('fetch').length).toBe(asked)
    expect(win().__drawn.at(-1).spec).toMatchObject({ mark: 'bar', height: 60 })
    // rows named down its side take 36 px each at most, so two bars stay bars; a y of numbers takes the height asked
    await win().thimble.chart('#c', BAR, { height: 200 })
    expect(win().__drawn.at(-1).spec.height).toBe(72)
    const line = { ...BAR, mark: 'line', encoding: { x: { field: 'posts', type: 'quantitative' }, y: { field: 'posts', type: 'quantitative' } } }
    await win().thimble.chart('#c', line, { height: 200 })
    expect(win().__drawn.at(-1).spec.height).toBe(200)
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
