// The view kit's row controls (backend/app/viewer_controls.js: thimble.filterBy, rows, timeline, key, divider), its side
// panel (viewer_side.js, thimble.side) and its transcript (viewer_transcript.js, thimble.transcript), in a jsdom window
// of their own with the bridge and Color by, as views.frame_document loads them: Filter by hides the rows whose value is
// off and gives the reader its choice as Color by's query; Rows groups the records by a field, a tree of them with its
// guides, or a label, every class of the label a group, so a class added to it is a new lane; the lanes draw a lane per
// group, a failure underlined in the problem red, and the key's entries turn their series off and on, an entry whose
// series never shows left out; the timeline works alone, on its records' own span of times or numbers with an axis of
// its own, its lanes from a field or a function; Reset turns every value and series back on; each control's choice is
// kept through the `colour` message; a transcript folds a tool call to one line until opened, opened and folded again
// by the chevron at the start of its head, and a long block to six lines, with Show more under it and Show less in its
// place. Layout (the side panel's width, the divider's drag, the lanes' cursor line and the tint of the list's rows in
// view) is tests/public/browser/view-parts.test.ts.
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

  test('an Alt-click shows a value alone; the counts the reader gives replace those of the page', async () => {
    await load()
    const w = win()
    w.eval(`window.filter = thimble.filterBy({ mount: '#filter', fields: ${JSON.stringify(FIELDS)} }); window.filter.choose('outcome')`)
    for (const c of CALLS) w.filter.keeps(c)
    await wait()
    const chip = doc().querySelectorAll('.thimble-filter-chip')[2] as HTMLElement
    chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, altKey: true }))
    await wait()
    expect(w.filter.values.map((v: any) => [v.name, v.on])).toEqual([['ok', false], ['error', false], ['denied', true]])
    w.filter.counts({ ok: 40, error: 7, denied: 2, '': 1 })
    await wait()
    expect(texts('.thimble-filter-chip')).toEqual(['ok40', 'error7', 'denied2', 'No outcome1'])
  })
})

describe('Rows', () => {
  test('a field with parentOf is a tree: each session under the one that spawned it, with its guide, left-aligned', async () => {
    await load()
    const w = win()
    w.PARENT = PARENT
    w.eval(`window.rows = thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session', parentOf: (k) => window.PARENT[k] }, { name: 'tool', title: 'Tool' }] })`)
    await wait()
    expect(texts('.thimble-rows-by')).toEqual(['Rows:Session'])
    const g = w.rows.groups(CALLS)
    expect(g.map((n: any) => `${n.guide}${n.name}`)).toEqual(['lead', '├ explore', '│ └ grep', '└ test'])
    expect(g.map((n: any) => n.items.length)).toEqual([2, 2, 1, 1])
  })

  test('the lanes regroup by a field, with a lane for the records with no value, and by a label: every class a lane, a class added to it a new lane', async () => {
    await load()
    const w = win()
    w.PARENT = PARENT
    w.CALLS = CALLS
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }] })
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

  test("it opens on a label named in `initial` while that label is on, else on the field after it; the label it groups by takes no colour", async () => {
    await load()
    const w = win()
    w.CALLS = CALLS
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }, { name: 'outcome', title: 'Outcome' }], initial: 'tool' })
      window.rows = thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session' }, { name: 'tool', title: 'Tool' }], initial: [{ label: 'tactic' }, 'tool'] })
    `)
    await wait()
    // no label yet: the field after it
    expect(texts('.thimble-rows-by')).toEqual(['Rows:Tool'])
    expect(w.rows.query()).toEqual({ field: 'tool' })
    // the label is on when the view first hears of the labels: Rows groups by it (found by its name, the case aside)
    // and Color by keeps its field, though a label turned on takes the colour otherwise
    labels()
    await wait()
    expect(texts('.thimble-rows-by')).toEqual(['Rows:Tactic'])
    expect(w.rows.query()).toEqual({ label: 'k1', name: 'Tactic' })
    expect(w.colour.by).toEqual({ field: 'tool', title: 'Tool' })
    // nothing was chosen, so nothing of Rows is kept: the view opens the same way again
    expect((of('colour').at(-1)?.state as any)?.parts?.rows?.by).toBe(undefined)
    // turned off, the label gives way to the field; on again, it is Rows' again, still not the colour
    labels(undefined, undefined, false)
    await wait()
    expect(texts('.thimble-rows-by')).toEqual(['Rows:Tool'])
    labels()
    await wait()
    expect(texts('.thimble-rows-by')).toEqual(['Rows:Tactic'])
    expect(w.colour.by).toEqual({ field: 'tool', title: 'Tool' })
    // a label no part holds still takes the colour when it is turned on
    const other = { id: 'k2', name: 'Phase', on: true, here: true, colour: '#b77300', values: [{ name: 'early', colour: '#b77300', highlight: true }], count: 1 }
    fromPage({ type: 'thimble:labels', marks: {}, on: [{ id: 'k1', name: 'Tactic', colour: '#025ac3', values: TACTIC(['explore', 'verify']).values }, { id: 'k2', name: 'Phase', colour: '#b77300', values: other.values }], filter: null, all: [TACTIC(['explore', 'verify']), other], palette: ['#025ac3'] })
    await wait()
    expect(w.colour.by).toEqual({ label: 'k2', title: 'Phase' })
    expect(texts('.thimble-rows-by')).toEqual(['Rows:Tactic'])
  })

  test('a record the reader gave its group keeps it, for the records the page does not anchor', async () => {
    await load()
    const w = win()
    w.eval(`window.rows = thimble.rows({ fields: [{ name: 'tool', title: 'Tool' }] })`)
    expect(w.rows.groups([{ ref: 'a#L1', tool: 'Bash', group: 'Edit' }]).map((n: any) => n.name)).toEqual(['Edit'])
  })
})

describe('the lanes and their key', () => {
  test("a failure is underlined in the problem red; the key's entries are toggles that hide their series; one that never shows is left out; Reset shows them again", async () => {
    await load()
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
    // no band ever shows, so the key has no `running`; `failed` with its count
    expect(texts('.thimble-key-chip')).toEqual(['failed2'])
    expect(doc().querySelector('.thimble-key-chip .thimble-key-problem')).not.toBe(null)
    ;(doc().querySelector('.thimble-key-chip') as HTMLElement).click()
    await wait()
    expect(doc().querySelector('.thimble-key-chip')!.getAttribute('aria-pressed')).toBe('false')
    expect(doc().querySelectorAll('.thimble-lane-bad')).toHaveLength(0)
    expect(w.lanes.isOn('problem')).toBe(false)
    await wait(60)
    ;(doc().querySelector('.thimble-reset') as HTMLElement).click()
    await wait()
    expect(w.lanes.isOn('problem')).toBe(true)
    expect(doc().querySelectorAll('.thimble-lane-bad')).toHaveLength(2)
  })

  test('with density each lane is bars on the bins, stacked by the Color by values, one height for every lane; a click on a bar opens its first record', async () => {
    await load()
    const w = win()
    w.CALLS = CALLS
    w.eval(`
      window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'outcome', title: 'Outcome', values: ['ok', 'error', 'denied'] }] })
      window.range = thimble.timeRange({ mount: '#range', times: window.CALLS.map((c) => c.t) })
      window.rows = thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session' }] })
      window.dense = false
      window.marked = []
      window.lanes = thimble.lanes({ mount: '#lanes', rows: window.rows, range: window.range, density: () => window.dense, onMark: (c) => window.marked.push(c.ref) })
      window.lanes.draw(window.CALLS)
    `)
    await wait()
    expect(doc().querySelectorAll('.thimble-lane-mark[data-i]')).toHaveLength(6)
    expect(doc().querySelector('#lanes')!.classList.contains('is-density')).toBe(false)
    w.dense = true
    w.lanes.draw()
    await wait()
    expect(doc().querySelector('#lanes')!.classList.contains('is-density')).toBe(true)
    expect(doc().querySelectorAll('.thimble-lane-mark[data-i]')).toHaveLength(0)
    const bars = [...doc().querySelectorAll('.thimble-lane-bar')]
    expect(bars.length).toBeGreaterThanOrEqual(5)
    // the lane of explore's two calls in one bin holds two values stacked, ok under error, in their chips' colours
    const explore = doc().querySelector('.thimble-lane[data-key="explore"]')!
    const fills = [...explore.querySelectorAll('.thimble-lane-bar')].map((b) => (b as HTMLElement).style.fill)
    expect(new Set(fills).size).toBe(fills.length)
    expect(fills.every(Boolean)).toBe(true)
    expect(explore.querySelector('svg')!.getAttribute('height')).toBe('36')
    // a click on a bar opens the first record of its bin
    ;(explore.querySelector('.thimble-lane-bar') as unknown as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 200 + Number(explore.querySelector('.thimble-lane-bar')!.getAttribute('x')) + 1 }))
    expect(w.marked).toEqual(['r1/explore.jsonl#L2'])
    // a value turned off keeps its part of the bars, in the lanes' gray (no fill of its own); ok keeps its colour
    ;(doc().querySelectorAll('.thimble-colour-chip')[1] as HTMLElement).click()
    await wait()
    expect(w.colour.isOn('error')).toBe(false)
    w.lanes.draw()
    const after = [...doc().querySelector('.thimble-lane[data-key="explore"]')!.querySelectorAll('.thimble-lane-bar')].map((b) => (b as HTMLElement).style.fill)
    expect(after).toEqual([fills[0], ''])
    // in Events too: every mark stays, explore's error call with no fill of its own beside its ok call in ok's colour
    w.dense = false
    w.lanes.draw()
    await wait()
    expect(doc().querySelectorAll('.thimble-lane-mark[data-i]')).toHaveLength(6)
    const exploreMarks = [...doc().querySelector('.thimble-lane[data-key="explore"]')!.querySelectorAll('.thimble-lane-mark[data-i]')].map((m) => (m as HTMLElement).style.fill)
    expect(exploreMarks).toEqual([fills[0], ''])
  })

  test("a click on a lane's name chooses it and tells the page; ▾ folds a parent's lanes into its own", async () => {
    await load()
    const w = win()
    w.CALLS = CALLS
    w.PARENT = PARENT
    w.eval(`
      window.range = thimble.timeRange({ mount: '#range', times: window.CALLS.map((c) => c.t) })
      window.rows = thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session', parentOf: (k) => window.PARENT[k] }] })
      window.picked = []
      window.lanes = thimble.lanes({ mount: '#lanes', rows: window.rows, range: window.range, onPick: (n) => window.picked.push(n.key) })
      window.lanes.draw(window.CALLS)
    `)
    await wait()
    ;(doc().querySelectorAll('.thimble-lane-name')[1] as HTMLElement).click()
    expect(w.picked).toEqual(['explore'])
    expect(w.lanes.chosen).toBe('explore')
    expect(doc().querySelector('.thimble-lane.is-chosen')!.getAttribute('data-key')).toBe('explore')
    ;(doc().querySelector('[data-fold="explore"]') as HTMLElement).click()
    await wait()
    expect(texts('.thimble-lane-name')).toEqual(['▾lead', '├ ▸explore', '└ test'])
    expect(w.lanes.lanes.find((n: any) => n.key === 'explore').items).toHaveLength(3)
    expect((of('colour').at(-1)!.state as any).parts['lanes:lanes']).toEqual({ folded: ['explore'] })
  })
})

describe('the timeline on its own', () => {
  const mount = (id: string) => doc().body.insertAdjacentHTML('beforeend', `<div id="${id}"></div>`)
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
    // an ISO time, seconds since 1970 and a Date each placed, in order, a few px in from the axis's edges, in gray
    const marks = [...doc().querySelectorAll('#lanes .thimble-lane-mark[data-i]')] as HTMLElement[]
    const xs = marks.map((m) => Number(m.getAttribute('x')))
    expect(w.tl.lanes[0].items.map((e: any) => e.ref)).toEqual(['a#L1', 'a#L2', 'a#L3'])
    expect(xs).toHaveLength(3)
    expect(xs[0]).toBeGreaterThan(2)
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 0)
    expect(xs[2]).toBeLessThan(798)
    expect(marks.every((m) => !m.style.fill)).toBe(true)
    // its axis over the lane, in hours
    const labels = texts('#lanes .thimble-lanes-axis .thimble-axis-lab')
    expect(labels.length).toBeGreaterThan(2)
    expect(labels).toContain('09:30')
    // the tip's head is the time alone, as there is no lane to name; the record's words under it
    hover(doc().querySelector('#lanes .thimble-lane')!, xs[1] + 1)
    expect(tipOf()).toEqual([expect.stringMatching(/^16 May 09:30:/), 'merged'])
  })

  test("its lanes from a field's name or a function of a record, with no Rows control: a lane per value as the records first take them, then the records with none", async () => {
    await load()
    const w = win()
    w.CALLS = CALLS.concat([{ ref: 'x#L1', t: T0 + 50, tool: 'Read', outcome: 'ok' } as any])
    mount('tl2')
    w.eval(`
      window.byField = thimble.timeline({ mount: '#lanes', rows: 'session' })
      window.byField.draw(window.CALLS)
      window.byFn = thimble.timeline({ mount: '#tl2', rows: (c) => (c.outcome === 'ok' ? 'ok' : 'failed') })
      window.byFn.draw(window.CALLS)
    `)
    await wait()
    expect(texts('#lanes .thimble-lane-name')).toEqual(['lead', 'explore', 'grep', 'test', 'No session'])
    expect(w.byField.lanes.map((l: any) => l.items.length)).toEqual([2, 2, 1, 1, 1])
    expect(doc().querySelector('#lanes')!.classList.contains('is-nameless')).toBe(false)
    expect(texts('#tl2 .thimble-lane-name')).toEqual(['ok', 'failed'])
    // a lane's name in its tip's head
    hover(doc().querySelector('#tl2 .thimble-lane')!, 300)
    expect(tipOf()![0]).toMatch(/^ok · 16 May/)
  })

  test("on plain numbers (unit 'n'): the marks at their numbers, the axis and the tip in numbers; with a range of numbers it takes the range's unit and draws no axis of its own", async () => {
    await load()
    const w = win()
    w.STEPS = [
      { turn: 0, agent: 'lead', text: 'plan' },
      { turn: 10, agent: 'sub', text: 'search' },
      { turn: '20', agent: 'lead', text: 'edit' },
      { turn: 40, agent: 'sub', text: 'done' },
      { turn: '2026-05-16', agent: 'sub', text: 'a date is no turn' },
    ]
    w.eval(`window.tl = thimble.timeline({ mount: '#lanes', rows: 'agent', unit: 'n', time: (s) => s.turn }); window.tl.draw(window.STEPS)`)
    await wait()
    expect(w.tl.lanes.map((l: any) => l.items.map((s: any) => s.turn))).toEqual([[0, '20'], [10, 40]])
    const x = (lane: number, i: number) => Number(doc().querySelectorAll('#lanes .thimble-lane')[lane].querySelectorAll('.thimble-lane-mark')[i].getAttribute('x'))
    // one scale for every lane: 0 to 20 is two thirds of 10 to 40
    expect(x(0, 1) - x(0, 0)).toBeCloseTo(((x(1, 1) - x(1, 0)) * 2) / 3, 0)
    const labels = texts('#lanes .thimble-lanes-axis .thimble-axis-lab')
    expect(labels.length).toBeGreaterThan(1)
    expect(labels.every((l) => /^\d+$/.test(l))).toBe(true)
    hover(doc().querySelectorAll('#lanes .thimble-lane')[0], 200 + x(0, 1) + 1)
    expect(tipOf()).toEqual(['lead · 20', 'edit'])
    // under a range of numbers: its scale and its unit, so the date is no turn there either; the range's axis is the page's
    mount('tl3')
    w.eval(`
      window.range = thimble.timeRange({ mount: '#range', unit: 'n', times: [0, 10, 20, 40] })
      window.ranged = thimble.timeline({ mount: '#tl3', range: window.range, rows: 'agent', time: (s) => s.turn })
      window.ranged.draw(window.STEPS)
    `)
    await wait()
    expect(w.ranged.lanes.flatMap((l: any) => l.items)).toHaveLength(4)
    expect(doc().querySelector('#tl3 .thimble-lanes-axis')).toBe(null)
    expect(w.ranged.scale.unit).toBe('n')
  })

  test("on plain numbers not all whole, such as scores: the axis in decimals and the tips as precise as four px; whole numbers never step under one", async () => {
    await load()
    const w = win()
    w.RUNS = [0.05, 0.31, 0.5, 0.72, 0.95].map((score, i) => ({ score, model: i % 2 ? 'b' : 'a', text: 'run ' + i }))
    w.eval(`window.tl = thimble.timeline({ mount: '#lanes', rows: 'model', unit: 'n', time: (r) => r.score }); window.tl.draw(window.RUNS)`)
    await wait()
    const labels = texts('#lanes .thimble-lanes-axis .thimble-axis-lab')
    expect(labels).toEqual(expect.arrayContaining(['0.2', '0.4', '0.6', '0.8']))
    expect(new Set(labels).size).toBe(labels.length)
    const lane = doc().querySelectorAll('#lanes .thimble-lane')[1]
    hover(lane, 200 + Number(lane.querySelector('.thimble-lane-mark')!.getAttribute('x')) + 1)
    expect(tipOf()).toEqual([expect.stringMatching(/^b · 0\.31\d$/), 'run 1'])
    // turns 0 to 3 across the width: a tick at each whole turn, each once
    mount('tl2')
    w.eval(`thimble.timeline({ mount: '#tl2', unit: 'n', time: (r) => r.turn }).draw([0, 1, 2, 3].map((turn) => ({ turn })))`)
    await wait()
    expect(texts('#tl2 .thimble-axis-lab')).toEqual(['0', '1', '2', '3'])
  })

  test("Density on scores: a score that falls on a bin's edge starts that bin, so scores 0.02 apart stand evenly apart", async () => {
    await load()
    const w = win()
    w.eval(`thimble.timeline({ mount: '#lanes', unit: 'n', density: true }).draw(Array.from({ length: 50 }, (_, i) => ({ t: i * 0.02 })))`)
    await wait()
    const xs = [...doc().querySelectorAll('#lanes .thimble-lane-bar')].map((b) => Number(b.getAttribute('x')))
    expect(xs).toHaveLength(50)
    const gaps = xs.slice(1).map((x, i) => x - xs[i])
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1)
  })

  test("Density's tip gives a bin's day once: 16 May 09:00–09:01", async () => {
    await load()
    const w = win()
    w.eval(`
      window.tl = thimble.timeline({ mount: '#lanes', density: true })
      window.tl.draw(Array.from({ length: 120 }, (_, i) => ({ t: ${T0} + i * 30 })))
    `)
    await wait()
    const bar = doc().querySelector('#lanes .thimble-lane-bar')!
    hover(doc().querySelector('#lanes .thimble-lane')!, Number(bar.getAttribute('x')) + 1)
    expect(tipOf()![0]).toMatch(/^16 May \d\d:\d\d(:\d\d)?–\d\d:\d\d(:\d\d)?$/)
  })

  test('a mark as wide as its record ran: the longest drawn first, so that it never hides a short one under it', async () => {
    await load()
    const w = win()
    w.eval(`
      window.tl = thimble.timeline({ mount: '#lanes', end: (r) => r.end })
      window.tl.draw([{ t: ${T0}, end: ${T0 + 5} }, { t: ${T0 + 1000}, end: ${T0 + 3000} }, { t: ${T0 + 1500} }])
    `)
    await wait()
    const marks = [...doc().querySelectorAll('#lanes .thimble-lane-mark')]
    expect(marks.map((m) => m.getAttribute('data-i'))).toEqual(['1', '0', '2'])
    expect(Number(marks[0].getAttribute('width'))).toBeGreaterThan(400)
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

  test("what Reload opens on follows the side panel: the record it opened, by a click or not, and none once it closed, by hand or by the page", async () => {
    await load()
    const w = win()
    w.eval(`window.side = thimble.side({ mount: '#body' })`)
    const state = async () => {
      fromPage({ type: 'thimble:state', id: of('state').length + 1 })
      await wait(10)
      return (of('state').at(-1)!.state as { ref: string | null }).ref
    }
    // thimble opens the view at a citation, which the page shows in the panel
    fromPage({ type: 'thimble:open', open: { ref: 'r1/lead.jsonl#L3' } })
    w.side.open({ title: 'Task', ref: 'r1/lead.jsonl#L3', html: '' })
    expect(await state()).toBe('r1/lead.jsonl#L3')
    // the page opens another record with no click, as ↑ and ↓ in a table do
    w.side.open({ title: 'Grep', ref: 'r1/explore.jsonl#L2', html: '' })
    expect(await state()).toBe('r1/explore.jsonl#L2')
    // the page closes the panel itself, as a second click on the open row does: no record, not the citation
    w.side.close()
    expect(await state()).toBe(null)
    // a click on a record names it again
    doc().getElementById('list')!.innerHTML = '<div class="row" data-anchor="r1/test.jsonl#L2">Bash</div>'
    ;(doc().querySelector('.row') as HTMLElement).click()
    expect(await state()).toBe('r1/test.jsonl#L2')
    // a new citation starts afresh
    w.side.close()
    fromPage({ type: 'thimble:open', open: { ref: 'r1/grep.jsonl#L2' } })
    expect(await state()).toBe('r1/grep.jsonl#L2')
  })

  test("a transcript: speaker, tool and time in the head, a failed call's ✕ before its tool; a tool call folded to one line until opened, its head's chevron opening and folding it; a long result folded to six lines, Show more and Show less in one place under it; a cited turn opened", async () => {
    await load()
    const w = win()
    const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    w.TURNS = [
      { ref: 's.jsonl#L1', t: T0, speaker: 'user', kind: 'prompt', text: 'Find the failing test', line: 1 },
      { ref: 's.jsonl#L2', t: T0 + 5, speaker: 'lead', kind: 'tool', tool: 'Bash', input: 'pytest -q\n--maxfail 1', output: long, error: true, line: 2, session: 'a' },
      { ref: 's.jsonl#L4', t: T0 + 9, speaker: 'lead', kind: 'text', text: 'One test fails.', line: 4, session: 'b', sessionName: 'explorer' },
    ]
    w.eval(`window.opened = []; window.tr = thimble.transcript({ mount: '#turns', onOpen: (t) => window.opened.push(t.ref) }); window.tr.draw(window.TURNS, { title: 'lead · Run 1' })`)
    expect([texts('.thimble-transcript-title'), texts('.thimble-transcript-n')]).toEqual([['lead · Run 1'], ['3 turns']])
    expect(texts('.thimble-turn-head')).toEqual(['user · 2026-05-16 09:00:00', 'lead · ✕ Bash · 2026-05-16 09:00:05', 'lead · 2026-05-16 09:00:09'])
    expect(texts('.thimble-turn-line')).toEqual(['Bash pytest -q'])
    // the turn that folds opens and folds by its head, a chevron at its start; a turn that does not fold has a plain head
    const toggle = () => doc().querySelector<HTMLElement>('[data-anchor="s.jsonl#L2"] .thimble-turn-head')!
    expect([toggle().tagName, toggle().getAttribute('aria-expanded'), !!toggle().querySelector('.thimble-turn-caret')]).toEqual(['BUTTON', 'false', true])
    expect(doc().querySelectorAll('.thimble-turn-toggle')).toHaveLength(1)
    // a failed call: ✕ and its tool in the problem red in its head, folded or open, its hover the failure's word
    const failed = doc().querySelector('.thimble-turn-failed')!
    expect([failed.textContent, failed.getAttribute('title')]).toEqual(['✕ Bash', 'failed'])
    w.tr.draw([{ ...w.TURNS[1], error: 'denied' }])
    expect(doc().querySelector('.thimble-turn-failed')!.getAttribute('title')).toBe('denied')
    w.tr.draw(w.TURNS, { title: 'lead · Run 1' })
    expect(texts('.thimble-transcript-session')).toEqual(['explorer'])
    // every turn is anchored with its ref, and its time for the lanes' tint
    expect([...doc().querySelectorAll('.thimble-turn')].map((e) => [e.getAttribute('data-anchor'), e.getAttribute('data-t')])).toEqual([
      ['s.jsonl#L1', String(T0)],
      ['s.jsonl#L2', String(T0 + 5)],
      ['s.jsonl#L4', String(T0 + 9)],
    ])
    ;(doc().querySelector('.thimble-turn-line') as HTMLElement).click()
    expect(w.opened).toEqual(['s.jsonl#L2'])
    // open, the same head folds it, its chevron turned; nothing else closes the turn
    expect([toggle().getAttribute('aria-expanded'), !!toggle().querySelector('.thimble-turn-caret')]).toEqual(['true', true])
    expect(doc().querySelector('[data-close], .thimble-turn-close')).toBe(null)
    expect(doc().getElementById('turns')!.textContent).not.toContain('Collapse')
    const call = doc().querySelector('.thimble-turn-call')!
    expect(call.querySelector('.thimble-turn-toolname')!.textContent).toBe('Bash')
    const result = doc().querySelector('.thimble-turn-result')!
    expect(result.classList.contains('is-error')).toBe(true)
    expect(result.parentElement!.classList.contains('is-folded')).toBe(true)
    // Show more under the cut text, and Show less in the same place once it is open; the control keeps the focus as its
    // turn is drawn again
    const more = () => doc().querySelector<HTMLElement>('.thimble-turn-more')!
    const place = () => [texts('.thimble-turn-more'), more().getAttribute('aria-expanded'), more().previousElementSibling === doc().querySelector('.thimble-turn-result')]
    expect(place()).toEqual([['Show more'], 'false', true])
    more().focus()
    more().click()
    expect(doc().querySelector('.thimble-turn-result')!.parentElement!.classList.contains('is-folded')).toBe(false)
    expect(place()).toEqual([['Show less'], 'true', true])
    expect(doc().activeElement).toBe(more())
    more().click()
    expect(doc().querySelector('.thimble-turn-result')!.parentElement!.classList.contains('is-folded')).toBe(true)
    expect(place()).toEqual([['Show more'], 'false', true])
    // the head folds the turn back to its line and keeps the focus, and opens it again
    toggle().focus()
    toggle().click()
    expect(doc().querySelector('.thimble-turn-call')).toBe(null)
    expect([toggle().getAttribute('aria-expanded'), doc().activeElement === toggle(), texts('.thimble-turn-line')]).toEqual(['false', true, ['Bash pytest -q']])
    toggle().click()
    expect(doc().querySelector('.thimble-turn-call')).not.toBe(null)
    toggle().click()
    expect(doc().querySelector('.thimble-turn-call')).toBe(null)
    // a citation opens the turn it names
    expect(w.tr.reveal('s.jsonl#L2')).toBe(true)
    expect(doc().querySelector('.thimble-turn-call')).not.toBe(null)
    expect(doc().querySelector('.thimble-turn-hit')!.getAttribute('data-anchor')).toBe('s.jsonl#L2')
  })

  test("a transcript's head writes each turn's time as the kit writes times, in UTC, however the record gives it, a time with no zone in UTC on a machine in any zone; a time it cannot read as written", async () => {
    const zone = process.env.TZ
    // a machine seven hours behind UTC in May, where the browser reads a date with no zone in its own
    process.env.TZ = 'America/Los_Angeles'
    try {
      await load()
      const w = win()
      const at = (i: number, t: unknown, key = 't') => ({ ref: `s.jsonl#L${i}`, [key]: t, speaker: 'lead', kind: 'text', text: 'ok', line: i })
      const read = [
        T0,
        (T0 + 1) * 1000,
        '2026-05-16T09:00:02.250000+00:00',
        '2026-05-16T11:00:03+02:00',
        '2026-05-16T09:00:04',
        '2026-05-16 09:00:05',
        String(T0 + 6),
        '2026-05-16T09:00:07Z',
        'Sat, 16 May 2026 09:00:08',
        'Sat, 16 May 2026 02:00:09 -0700',
        '2026/05/16 09:00:10',
        '2026-05-16 09:00:11 UTC',
      ]
      w.TURNS = [...read.map((t, i) => at(i + 1, t, i === 7 ? 'time' : 't')), at(13, 'step 4'), at(14, null)]
      w.eval(`thimble.transcript({ mount: '#turns' }).draw(window.TURNS)`)
      expect(texts('.thimble-turn-head')).toEqual([...read.map((_, i) => `lead · 2026-05-16 09:00:${String(i).padStart(2, '0')}`), 'lead · step 4', 'lead'])
      // the lanes follow a time given as text too, in seconds; a number as given
      expect([...doc().querySelectorAll('.thimble-turn')].map((e) => e.getAttribute('data-t'))).toEqual(
        [T0, (T0 + 1) * 1000, T0 + 2.25, ...read.slice(3).map((_, i) => T0 + 3 + i)].map(String).concat([null, null] as never[]),
      )
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
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
