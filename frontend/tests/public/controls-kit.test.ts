// The view kit's row controls (backend/app/viewer_controls.js: thimble.filterBy, rows, timeline, key), its side panel
// (viewer_side.js, thimble.side) and the bridge and Color by they work with, in a jsdom window of their own as
// views.frame_document loads them: Filter by hides the rows whose value is off; Rows groups the lanes by a field or a
// label, every class of the label a lane; a failure is drawn in the problem red and always shown; the timeline works
// alone on its records' own span; a record opens in the side panel beside the list; and every choice of the controls
// draws with no script error.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const APP = path.resolve(__dirname, '../../../backend/app')
const read = (n: string) => readFileSync(path.join(APP, n), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
// the kit as views.frame_document loads it: the bridge, the palette's order, Color by, the controls, the side panel, the
// transcript, then the range, which takes the bridge's part away
const KIT =
  script(read('viewer_bridge.js')) +
  script(`window.__thimbleLabelOrder = ${read('label_order.json')}`) +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_range.js'].map((n) => script(read(n))).join('')

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any; [k: string]: any }
const doc = () => dom.window.document
const fromPage = (data: object) => win().dispatchEvent(new dom.window.MessageEvent('message', { data, source: win().parent as any }))
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)
const texts = (sel: string) => [...doc().querySelectorAll(sel)].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())

const T0 = Date.UTC(2026, 4, 16, 9) / 1000
// a lead and its subagents in one run: six calls, two of them failed
const CALLS = [
  { ref: 'r1/lead.jsonl#L3', t: T0, session: 'lead', tool: 'Task', outcome: 'ok' },
  { ref: 'r1/explore.jsonl#L2', t: T0 + 60, session: 'explore', tool: 'Grep', outcome: 'ok' },
  { ref: 'r1/explore.jsonl#L4', t: T0 + 90, session: 'explore', tool: 'Read', outcome: 'error' },
  { ref: 'r1/grep.jsonl#L2', t: T0 + 100, session: 'grep', tool: 'Grep', outcome: 'ok' },
  { ref: 'r1/test.jsonl#L2', t: T0 + 200, session: 'test', tool: 'Bash', outcome: 'denied' },
  { ref: 'r1/lead.jsonl#L9', t: T0 + 300, session: 'lead', tool: '', outcome: 'ok' },
]
const PARENT: Record<string, string | null> = { lead: null, explore: 'lead', grep: 'explore', test: 'lead' }

async function load(kept?: object) {
  const page = `<!doctype html><html><head>${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${KIT}</head><body>
<div class="top"><span id="filter"></span><span id="rows"></span><span id="colour"></span></div><div id="range"></div><div id="lanes"></div><div id="body"><div id="list"></div></div><div id="turns"></div></body></html>`
  dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  sent = []
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  await wait()
}
afterEach(() => dom?.window.close())

const TACTIC = (values: string[]) => ({
  id: 'k1',
  name: 'Tactic',
  on: true,
  here: true,
  colour: '#025ac3',
  values: values.map((v) => ({ name: v, colour: '#025ac3', highlight: true })),
  count: 3,
})
// the label Tactic, on with its values on three of the calls, or off
function labels(values = ['explore', 'verify'], marks: Record<string, string> = { 'r1/lead.jsonl#L3': 'explore', 'r1/explore.jsonl#L2': 'explore', 'r1/test.jsonl#L2': 'verify' }, on = true) {
  const m: Record<string, object> = {}
  if (on) for (const [ref, v] of Object.entries(marks)) m[ref] = { bar: '#025ac3', names: ['Tactic'], values: [{ id: 'k1', label: 'Tactic', value: v, colour: '#025ac3' }], spans: [] }
  const l = { ...TACTIC(values), on }
  fromPage({ type: 'thimble:labels', marks: m, on: on ? [{ id: 'k1', name: 'Tactic', colour: '#025ac3', values: l.values }] : [], filter: null, all: [l], palette: ['#025ac3'] })
}

const FIELDS = [
  { name: 'tool', title: 'Tool' },
  { name: 'outcome', title: 'Outcome', values: ['ok', 'error', 'denied'], meanings: { denied: 'permission was denied' } },
]

describe('Filter by', () => {
  test("its menu picks a field; the field's values are toggles in the row, with no colour; a value turned off hides its rows; the reader gets Color by's query", async () => {
    await load()
    const w = win()
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }] })
      window.drawn = 0
      window.draw = () => { window.drawn++; document.getElementById('list').innerHTML = window.CALLS.filter((c) => window.filter.keeps(c)).map((c) => '<div class="row" data-anchor="' + c.ref + '">' + c.ref + '</div>').join('') }
      window.filter = thimble.filterBy({ mount: '#filter', fields: ${JSON.stringify(FIELDS)}, onChange: () => window.draw() })
    `)
    w.CALLS = CALLS
    w.draw()
    await wait()
    expect(texts('.thimble-filter-by')).toEqual(['Filter by'])
    expect(w.filter.by).toBe(null)
    expect(w.filter.query()).toBe(null)
    expect(doc().querySelectorAll('.row')).toHaveLength(6)
    // the menu: None, the fields with their values in words, the labels
    ;(doc().querySelector('.thimble-filter-by') as HTMLElement).click()
    await wait()
    expect(texts('.thimble-colour-menu .thimble-colour-choice .thimble-colour-nm')).toEqual(['None', 'Tool', 'Outcome'])
    expect(texts('.thimble-colour-menu [data-by="f:outcome"] .thimble-colour-preview')).toEqual(['ok · error · denied'])
    ;(doc().querySelector('.thimble-colour-menu [data-by="f:outcome"]') as HTMLElement).click()
    await wait()
    expect(doc().querySelector('.thimble-colour-menu')).toBe(null)
    expect(texts('.thimble-filter-by')).toEqual(['Filter by:Outcome'])
    // the toggles, each a box and a count, none with a colour swatch
    expect(texts('.thimble-filter-chip')).toEqual(['ok4', 'error1', 'denied1'])
    expect(doc().querySelectorAll('.thimble-filter .chip-sw')).toHaveLength(0)
    ;(doc().querySelectorAll('.thimble-filter-chip')[1] as HTMLElement).click()
    await wait()
    expect(doc().querySelectorAll('.thimble-filter-chip')[1].getAttribute('aria-pressed')).toBe('false')
    expect(texts('.row')).not.toContain('r1/explore.jsonl#L4')
    expect(doc().querySelectorAll('.row')).toHaveLength(5)
    expect(w.filter.query()).toEqual({ field: 'outcome', off: ['error'] })
    expect(w.filter.isOn('error')).toBe(false)
    // the choice and the values turned off are kept per view, beside Color by's
    const kept = of('colour').at(-1)!.state as any
    expect(kept.parts.filter).toEqual({ by: 'f:outcome', off: { 'f:outcome': ['error'] } })
    // Reset, at the end of Color by's row, turns them back on and draws once
    const before = w.drawn
    await wait(60)
    const reset = doc().querySelector('.thimble-reset') as HTMLButtonElement
    expect(reset.hidden).toBe(false)
    reset.click()
    await wait()
    expect(doc().querySelectorAll('.row')).toHaveLength(6)
    expect(w.drawn).toBeGreaterThan(before)
    expect(w.filter.query()).toEqual({ field: 'outcome', off: [] })
  })
})

describe('Rows', () => {

  test('the lanes regroup by a field, with a lane for the records with no value, and by a label: every class a lane, a class added to it a new lane', async () => {
    await load()
    const w = win()
    w.PARENT = PARENT
    w.CALLS = CALLS
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }], initial: 'tool' })
      window.range = thimble.timeRange({ mount: '#range', times: window.CALLS.map((c) => c.t) })
      window.redraws = 0
      window.rows = thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session', parentOf: (k) => window.PARENT[k] }, { name: 'tool', title: 'Tool' }], onChange: () => { window.redraws++; window.lanes.draw(window.CALLS) } })
      window.lanes = thimble.lanes({ mount: '#lanes', rows: window.rows, range: window.range, problem: (c) => c.outcome !== 'ok' })
      window.lanes.draw(window.CALLS)
    `)
    await wait()
    const lanes = () => texts('.thimble-lane-name')
    // each parent's ▾ folds the lanes under it
    expect(lanes()).toEqual(['▾lead', '├ ▾explore', '│ └ grep', '└ test'])
    // by the tool: its values as the records first take them, then the calls with none
    w.rows.choose('tool')
    await wait()
    expect(lanes()).toEqual(['Task', 'Grep', 'Read', 'Bash', 'No tool'])
    expect(w.rows.query()).toEqual({ field: 'tool' })
    // by a label: chosen while it is off, Rows turns it on (thimble.setLabel, here refused with no click), and once
    // thimble says it is on, each class is a lane, then the records it does not mark
    labels(undefined, undefined, false)
    await wait()
    w.rows.choose({ label: 'k1' })
    labels()
    await wait()
    expect(lanes()).toEqual(['explore', 'verify', 'Not marked'])
    expect(w.lanes.lanes.map((n: any) => n.items.length)).toEqual([2, 1, 3])
    expect(texts('.thimble-rows-by')).toEqual(['Rows:Tactic'])
    // the label gains a class: the lanes follow it, with no click
    const was = w.redraws
    labels(['explore', 'verify', 'plan'], { 'r1/lead.jsonl#L3': 'explore', 'r1/explore.jsonl#L2': 'explore', 'r1/test.jsonl#L2': 'verify', 'r1/lead.jsonl#L9': 'plan' })
    await wait()
    expect(w.redraws).toBeGreaterThan(was)
    expect(lanes()).toEqual(['explore', 'verify', 'plan', 'Not marked'])
    // Color by kept its own choice: choosing a label for Rows does not color by it
    expect(w.colour.by).toEqual({ field: 'tool', title: 'Tool' })
    // the choice is kept per view
    expect((of('colour').at(-1)!.state as any).parts.rows).toEqual({ by: 'l:k1' })
  })
})

describe('the lanes and their key', () => {
  test("a failure is a ✕ in the problem red at its mark's foot, over every mark, always shown: the key has no entry for it, and a `problem` an older key kept turned off is dropped; an entry whose series never shows is left out", async () => {
    // the key of a version that had a `failed` entry, kept with it turned off
    await load({ v: 1, parts: { 'key:lanes:lanes': { off: ['problem'] } } })
    const w = win()
    w.CALLS = CALLS
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }] })
      window.range = thimble.timeRange({ mount: '#range', times: window.CALLS.map((c) => c.t) })
      window.rows = thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session' }] })
      window.lanes = thimble.lanes({ mount: '#lanes', rows: window.rows, range: window.range, problem: (c) => c.outcome !== 'ok', band: (n) => [] })
      window.lanes.draw(window.CALLS)
    `)
    await wait()
    expect(doc().querySelectorAll('.thimble-lane-bad')).toHaveLength(2)
    // each ✕ a halo of the paper under its red strokes, after the lane's marks, centered on the foot of its failed
    // call's mark
    for (const bad of doc().querySelectorAll('.thimble-lane-bad')) {
      expect([...bad.children].map((p) => p.getAttribute('class'))).toEqual(['thimble-lane-bad-halo', 'thimble-lane-bad-x'])
      expect(bad.nextElementSibling).toBe(null)
      const d = bad.children[1].getAttribute('d')!
      const [x0, y0, dx, dy] = (/^M([\d.]+) ([\d.]+)l([\d.]+) ([\d.]+)M/.exec(d) || []).slice(1).map(Number)
      expect([dx, dy]).toEqual([6, 6])
      const mark = [...bad.parentElement!.querySelectorAll('.thimble-lane-mark')].find((m) => Math.abs(Number(m.getAttribute('x')) + Number(m.getAttribute('width')) / 2 - (x0 + dx / 2)) < 0.15)
      expect(mark, d).toBeTruthy()
      expect(y0 + dy / 2).toBeCloseTo(Number(mark!.getAttribute('y')) + Number(mark!.getAttribute('height')), 5)
    }
    // no band ever shows, so the key has no `running`; a failure takes no entry, since its ✕ always shows
    expect(texts('.thimble-key-chip')).toEqual([])
    expect(doc().querySelector('.thimble-key-problem')).toBe(null)
    // the `problem` the older key kept turned off is dropped: it hides no ✕, and Reset does not show for it
    expect(w.lanes.isOn('problem')).toBe(true)
    await wait(60)
    expect((doc().querySelector('.thimble-reset') as HTMLButtonElement).hidden).toBe(true)
    expect(doc().querySelectorAll('.thimble-lane-bad')).toHaveLength(2)
  })
})

describe('the timeline on its own', () => {
  const tipOf = () => {
    const t = doc().querySelector('.thimble-tip') as HTMLElement | null
    return t && t.style.display === 'block' ? [...t.children].map((c) => c.textContent) : null
  }
  const hover = (lane: Element, x: number) => lane.querySelector('svg')!.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: x }))

  test("with no Color by, range or Rows: one lane with no name on its records' own span, with an axis of its own; a record with no place is left out; thimble.lanes is the same call", async () => {
    await load()
    const w = win()
    w.eval(`
      window.EVENTS = [
        { ref: 'a#L1', t: '2026-05-16T09:00:00Z', text: 'opened' },
        { ref: 'a#L2', t: ${T0 + 1800}, text: 'merged' },
        { ref: 'a#L3', t: new Date(${(T0 + 3600) * 1000}), text: 'closed' },
        { ref: 'a#L4', t: 'soon', text: 'no time' },
      ]
      window.tl = thimble.timeline({ mount: '#lanes' })
      window.tl.draw(window.EVENTS)
    `)
    await wait()
    expect(w.thimble.lanes).toBe(w.thimble.timeline)
    expect(doc().querySelectorAll('#lanes .thimble-lane')).toHaveLength(1)
    expect(doc().querySelector('#lanes .thimble-lane-name')).toBe(null)
    expect(doc().querySelector('#lanes')!.classList.contains('is-nameless')).toBe(true)
    // an ISO time, seconds since 1970 and a Date each placed, in order, a few px in from the axis's edges, in the one
    // series color (jsdom resolves no CSS variable), as a chart of one series
    const marks = [...doc().querySelectorAll('#lanes .thimble-lane-mark[data-i]')] as HTMLElement[]
    const xs = marks.map((m) => Number(m.getAttribute('x')))
    expect(w.tl.lanes[0].items.map((e: any) => e.ref)).toEqual(['a#L1', 'a#L2', 'a#L3'])
    expect(xs).toHaveLength(3)
    expect(xs[0]).toBeGreaterThan(2)
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 0)
    expect(xs[2]).toBeLessThan(798)
    expect(marks.map((m) => m.style.fill)).toEqual(['var(--viz-1)', 'var(--viz-1)', 'var(--viz-1)'])
    // its axis over the lane, in hours
    const labels = texts('#lanes .thimble-lanes-axis .thimble-axis-lab')
    expect(labels.length).toBeGreaterThan(2)
    expect(labels).toContain('09:30')
    // the tip's head is the time alone, as there is no lane to name; the record's words under it
    hover(doc().querySelector('#lanes .thimble-lane')!, xs[1] + 1)
    expect(tipOf()).toEqual([expect.stringMatching(/^May 16 09:30:/), 'merged'])
  })
})

describe('the side panel and the transcript', () => {
  test('a record opens in the side panel beside the list, never under its row; Escape or × closes it; Reset closes it too', async () => {
    await load()
    const w = win()
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [] })
      window.closed = []
      window.side = thimble.side({ mount: '#body', onClose: (ref) => window.closed.push(ref) })
    `)
    expect(w.side.isOpen).toBe(false)
    w.side.open({ title: 'Read src/app.py', sub: 'r1/explore.jsonl line 4', ref: 'r1/explore.jsonl#L4', html: '<pre>def main(): ...</pre>' })
    expect(w.side.isOpen).toBe(true)
    expect(w.side.ref).toBe('r1/explore.jsonl#L4')
    const panel = doc().querySelector('#body > .thimble-side')!
    expect(panel.querySelector('.thimble-side-title')!.textContent).toBe('Read src/app.py')
    expect(panel.querySelector('.thimble-side-body pre')).not.toBe(null)
    expect(doc().getElementById('list')!.querySelector('.thimble-side')).toBe(null)
    panel.querySelector('.thimble-side-body')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.side.isOpen).toBe(false)
    expect(w.closed).toEqual(['r1/explore.jsonl#L4'])
    w.side.open({ title: 'again', ref: 'x#L1', html: '' })
    await wait(60)
    ;(doc().querySelector('.thimble-reset') as HTMLElement).click()
    await wait()
    expect(w.side.isOpen).toBe(false)
  })
})

describe("every choice of the kit's controls draws", () => {
  test('Color by, Rows and Filter by, Off and None among them, each chosen in turn with the lanes drawn: no script error', async () => {
    await load()
    const w = win()
    const colour = w.thimble.colorBy({ mount: '#colour', fields: FIELDS, strip: '#list', onChange: () => draw() })
    const filter = w.thimble.filterBy({ mount: '#filter', fields: FIELDS, onChange: () => draw() })
    const rows = w.thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session', parentOf: (k: string) => PARENT[k] }, ...FIELDS], onChange: () => draw() })
    const lanes = w.thimble.lanes({ mount: '#lanes', rows, colour, range: { scale: () => ({ x: (t: number) => t - T0, t0: T0, t1: T0 + 300 }) }, problem: (c: any) => c.outcome !== 'ok' })
    function draw() {
      const shown = CALLS.filter((c) => filter.keeps(c))
      lanes.draw(shown)
      doc().getElementById('list')!.innerHTML = shown.map((c) => `<div data-anchor="${c.ref}"${colour.attr(c)}>${c.tool}</div>`).join('')
      for (const g of rows.groups(shown)) void g.name
    }
    draw()
    labels()
    await wait()
    const list = w.thimble.__choices() as { control: string; choice: string; go: () => void }[]
    expect(list.map((x) => `${x.control}: ${x.choice}`)).toEqual(expect.arrayContaining(['Color by: Off', 'Rows: None', 'Filter by: None', 'Rows: Tactic', 'Color by: Tactic', 'Filter by: Tactic']))
    for (const x of [...list, ...list.slice().reverse()]) {
      x.go()
      await wait(20)
    }
    await wait()
    expect(of('error').map((m) => m.message), 'the kit reported no error').toEqual([])
  })
})
