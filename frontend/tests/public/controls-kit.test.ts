// The view kit's row controls (backend/app/viewer_controls.js: thimble.filterBy, rows, lanes, key, divider), its side
// panel (viewer_side.js, thimble.side) and its transcript (viewer_transcript.js, thimble.transcript), in a jsdom window
// of their own with the bridge and Color by, as views.frame_document loads them: Filter by hides the rows whose value is
// off and gives the reader its choice as Color by's query; Rows groups the records by a field, a tree of them with its
// guides, or a label, every class of the label a group, so a class added to it is a new lane; the lanes draw a lane per
// group, a failure underlined in the problem red, and the key's entries turn their series off and on, an entry whose
// series never shows left out; Reset turns every value and series back on; each control's choice is kept through the
// `colour` message; a transcript folds a tool call to one line until opened. Layout (the side panel's width, the
// divider's drag, the lanes' cursor line and the tint of the list's rows in view) is
// tests/public/browser/view-parts.test.ts.
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

  test('a transcript: speaker, tool and time in the head; a tool call folded to one line until opened; a long result folded to six lines; a cited turn opened', async () => {
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
    expect(texts('.thimble-turn-head')).toEqual(['user · 2026-05-16 09:00:00', 'lead · Bash · 2026-05-16 09:00:05', 'lead · 2026-05-16 09:00:09'])
    expect(texts('.thimble-turn-line')).toEqual(['Bash pytest -q'])
    expect(texts('.thimble-transcript-session')).toEqual(['explorer'])
    // every turn is anchored with its ref, and its time for the lanes' tint
    expect([...doc().querySelectorAll('.thimble-turn')].map((e) => [e.getAttribute('data-anchor'), e.getAttribute('data-t')])).toEqual([
      ['s.jsonl#L1', String(T0)],
      ['s.jsonl#L2', String(T0 + 5)],
      ['s.jsonl#L4', String(T0 + 9)],
    ])
    ;(doc().querySelector('.thimble-turn-line') as HTMLElement).click()
    expect(w.opened).toEqual(['s.jsonl#L2'])
    const call = doc().querySelector('.thimble-turn-call')!
    expect(call.querySelector('.thimble-turn-toolname')!.textContent).toBe('Bash')
    const result = doc().querySelector('.thimble-turn-result')!
    expect(result.classList.contains('is-error')).toBe(true)
    expect(result.parentElement!.classList.contains('is-folded')).toBe(true)
    expect(texts('.thimble-turn-expand')[0]).toBe('Expand12 lines')
    ;(doc().querySelector('[data-expand]') as HTMLElement).click()
    expect(doc().querySelector('.thimble-turn-result')!.parentElement!.classList.contains('is-folded')).toBe(false)
    ;(doc().querySelector('[data-close]') as HTMLElement).click()
    expect(doc().querySelector('.thimble-turn-call')).toBe(null)
    // a citation opens the turn it names
    expect(w.tr.reveal('s.jsonl#L2')).toBe(true)
    expect(doc().querySelector('.thimble-turn-call')).not.toBe(null)
    expect(doc().querySelector('.thimble-turn-hit')!.getAttribute('data-anchor')).toBe('s.jsonl#L2')
  })
})
