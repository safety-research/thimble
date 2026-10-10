// The terminal view kit (backend/app/term_kit/kit.mjs), which a view's view.term.js imports to draw the view in
// terminal mode (docs/terminal-views.md): its rows and hot regions in thimble-term's look, the keys a pane passes on
// and the hint row they make, Color by with its chips and a label's definition a step away, the time range's strip and
// window, the list with its chosen row, details in place and colored track, and acts only during the analyst's own key
// or click. Each test plays the runtime's half (init, events, answers) in this process; the sandboxed process and the
// view host are backend/tests_public/test_term_views.py.
import { beforeEach, describe, expect, test } from 'vitest'

type Msg = { t: string; [k: string]: any }
// the kit is plain JavaScript that the sandboxed runtime imports; a string URL keeps it out of the type check
const KIT_URL = new URL('../../../backend/app/term_kit/kit.mjs', import.meta.url).href
const kit: any = await import(/* @vite-ignore */ KIT_URL)

let sent: Msg[] = []
const tick = () => new Promise((r) => setTimeout(r, 0))
const frames = () => sent.filter((m) => m.t === 'frame')
const last = () => frames().at(-1)!
const text = (f = last()) => f.lines.map((l: { s: string }[]) => l.map((s) => s.s).join('').replace(/\s+$/, ''))
// an open menu's rows, inside its frame: `❯ all`, `  INC-311`
const menu = (rows = text()) => rows.filter((r: string) => /^\s*│/.test(r)).map((r: string) => r.replace(/^\s*│ /, '').replace(/\s*│$/, ''))
let n = 0

const LABELS = [
  { id: 'k1', name: 'Database connections', kind: 'regex', text: '', spec: '(?i)connections?', scope: 'agents.log', values: [{ name: 'connections', meaning: 'mentions the pool', n: 23 }, { name: 'other', meaning: '', n: 590 }], here: true },
]

function init(o: Record<string, unknown> = {}) {
  kit.__driver.reset()
  sent = []
  n = 0
  kit.__driver.connect((m: Msg) => sent.push(m))
  kit.handle({ t: 'init', cols: 80, rows: 20, view: { slug: 'v', name: 'V' }, labels: LABELS, state: {}, ...o })
}
async function key(k: string) {
  kit.handle({ t: 'key', key: k, n: ++n })
  await tick()
}
async function click(words: string, x = 0) {
  const f = last()
  const rows = text(f)
  const i = f.hits.findIndex((h: any) => (rows[h.y] ?? '').slice(h.x0, h.x1).includes(words))
  expect(i, `a hot region shows ${words}`).toBeGreaterThanOrEqual(0)
  kit.handle({ t: 'click', i, seq: f.seq, x, n: ++n })
  await tick()
}

beforeEach(() => init())

describe('text', () => {
  test('width counts wide characters twice; cut keeps whole words and puts … against the last one', () => {
    expect(kit.width('ab漢字')).toBe(6)
    expect(kit.cut('Restarted payments-2 (health check failing)', 24)).toBe('Restarted payments-2…')
    expect(kit.cut('short', 10)).toBe('short')
    expect(kit.clip('{"id": "alr-42", "ts": 1}', 10)).toBe('{"id": "a…')
    expect(kit.wrap('one two three four five', 9)).toEqual(['one two', 'three', 'four five'])
    expect(kit.wrap('one two three four five six', 9, 2)).toEqual(['one two', 'three…'])
    expect(kit.num(14591)).toBe('14,591')
    // a cut keeps the cells it is padded to, so the column after it keeps its place
    expect(kit.pad('Brambleway API v3 migration guide', 20)).toBe('Brambleway API v3…  ')
    expect(kit.padStart('Brambleway API v3 migration guide', 20)).toBe('  Brambleway API v3…')
    expect(kit.dur(130)).toBe('2m 10s')
    expect(kit.when(Date.UTC(2026, 4, 16, 4, 31) / 1000)).toBe('16 May 04:31')
    expect(kit.placeWords('alerts/x.jsonl#L12')).toBe('alerts/x.jsonl line 12')
    expect(kit.placeWords('deploys.csv#row=3')).toBe('deploys.csv row 3')
    expect(kit.placeWords('chat/ops.json#/messages/0')).toBe('chat/ops.json message 1')
  })
})

describe('the drawing', () => {
  test('rows carry a 2-cell margin, hot regions are counted from the frame\'s left edge, and nothing passes the rows or the columns (a cut row ends in …)', async () => {
    init({ cols: 30, rows: 3 })
    kit.draw((d: any) => {
      d.row().margin({ s: '❯' }).add('one', {}, { on: () => {} }).right('R', { d: true }).end()
      d.line('x'.repeat(50))
      d.line('three')
      d.line('four')
    })
    await tick()
    const f = last()
    expect(text(f)).toEqual(['❯ one' + ' '.repeat(26) + 'R', '  ' + 'x'.repeat(29) + '…', '  three'])
    expect(f.hits[0]).toMatchObject({ y: 0, x0: 2, x1: 5 })
  })

  test('a blank row never doubles and never opens the drawing', async () => {
    kit.draw((d: any) => {
      d.blank()
      d.line('a')
      d.blank()
      d.blank()
      d.line('b')
    })
    await tick()
    expect(text()).toEqual(['  a', '', '  b'])
  })

  test('the hint row names bound keys in the panel\'s order, and a key the pane does not pass on cannot be bound', async () => {
    kit.draw((d: any) => {
      d.key('/', 'to search', () => {})
      d.key('return', 'to open', () => {})
      d.key(['up', 'down'], 'to choose', () => {})
      d.key(['n', 'p'], 'for the next lane', () => {})
    })
    await tick()
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to open', '/ to search', 'n p for the next lane'])
    expect(last().hintKeys).toEqual([['up', 'down'], ['return'], ['/'], ['n', 'p']])
    expect(last().keys.sort()).toEqual(['/', 'down', 'n', 'p', 'return', 'up'].sort())
    const d = new kit.Drawing(40, 5)
    for (const k of ['left', 'right', 'pageup', 'home', 'end', 'tab', 'escape']) expect(() => d.key(k, 'x', () => {})).toThrow(/does not reach a view's pane/)
    for (const k of ['b', 't', 'x']) expect(() => d.key(k, 'x', () => {})).toThrow(/the panel's own/)
    expect(() => d.key('Q', 'x', () => {})).toThrow(/lowercase/)
    expect(() => d.key('ab', 'x', () => {})).toThrow(/one character/)
  })

  test('the hint row names ↑↓, Enter and the view\'s first two keys of its own, never a kit part\'s; ? lists every key in a frame over the top rows, and any other key closes it and acts', async () => {
    const colour = kit.colorBy({ fields: [{ name: 'kind', title: 'Kind' }] })
    const rows = kit.list({ key: (m: any) => m.id })
    const got: string[] = []
    kit.draw((d: any) => {
      colour.draw(d)
      d.key('s', 'to read the spawn', () => got.push('s'))
      d.key(['n', 'p'], 'for the next lane', () => got.push('n'))
      d.key('u', 'to read the lead', () => got.push('u'))
      rows.draw(d, { items: [{ id: 1, t: 'one' }, { id: 2, t: 'two' }], row: (m: any, r: any) => r.add(m.t), ask: (m: any) => ({ ref: String(m.id), text: m.t }) })
    })
    await tick()
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to open', 's to read the spawn', 'n p for the next lane', '? for all keys'])
    expect(last().hintKeys.at(-1)).toEqual(['?'])
    // the keys the row leaves out still work
    expect(last().keys).toEqual(expect.arrayContaining(['c', 'a', 'u', '?']))
    await key('u')
    expect(got).toEqual(['u'])
    await key('?')
    const t = text()
    expect(t[0]).toMatch(/^ {2}╭─ keys ─+╮$/)
    const listed = t.slice(1, t.findIndex((r: string) => r.includes('╰'))).map((r: string) => r.replace(/^\s*│\s+/, '').replace(/\s*│$/, '').split(/\s{2,}/))
    expect(listed).toEqual([['↑↓', 'to choose'], ['Enter', 'to open'], ['c', 'to color by'], ['s', 'to read the spawn'], ['n p', 'for the next lane'], ['u', 'to read the lead'], ['a', 'to ask']])
    expect(last().hints).toContain('? to hide the keys')
    // a key other than ? closes the list, and does what it does
    await key('n')
    expect(got).toEqual(['u', 'n'])
    expect(text()[0]).not.toContain('keys')
    await key('?')
    await key('?')
    expect(text()[0]).not.toContain('keys')
  })

  test('? is bound only where the hint row leaves a key unnamed, and never over a ? of the view\'s own', async () => {
    let own = false
    kit.draw((d: any) => {
      d.key(['up', 'down'], 'to choose', () => {})
      d.key('return', 'to open', () => {})
      if (own) d.key('?', 'for help', () => {})
      else d.key('h', 'for help', () => {})
    })
    await tick()
    expect(last().keys).not.toContain('?')
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to open', 'h for help'])
    own = true
    kit.redraw()
    await tick()
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to open', '? for help'])
  })

  test('a key runs what the frame bound it to; a strong binding (an open menu\'s) keeps its keys from a later one', async () => {
    const got: string[] = []
    kit.draw((d: any) => {
      d.key(['up', 'down'], 'in the menu', (k: string) => got.push(`menu ${k}`), true)
      d.key(['up', 'down'], 'to choose', (k: string) => got.push(`list ${k}`))
      d.key('return', 'to open', () => got.push('open'))
    })
    await tick()
    await key('down')
    await key('return')
    await key('q')
    expect(got).toEqual(['menu down', 'open'])
    expect(last().hints).toEqual(['↑↓ in the menu', 'Enter to open'])
  })

  test('a draw that throws is one red line saying why, and binds nothing', async () => {
    kit.draw(() => {
      throw new TypeError('E is undefined')
    })
    await tick()
    expect(text()).toEqual(['  × the view could not be drawn: TypeError: E is undefined'])
    expect(last().lines[0][1].fg).toBe('error')
    expect(last().keys).toEqual([])
  })
})

describe('acts', () => {
  test('open, ask and openLabel reach thimble only during the analyst\'s own key or click, with that event\'s number', async () => {
    kit.draw((d: any) => {
      d.key('o', 'to open its place', () => kit.open('agents.log#L3'))
      d.row().add('ask', {}, { on: () => kit.ask('agents.log#L3', 'Restarted  payments-2') }).end()
    })
    await tick()
    expect(() => kit.open('agents.log#L3')).toThrow(/only during the analyst's own click or key/)
    await key('o')
    await click('ask')
    const acts = sent.filter((m) => m.t === 'act')
    expect(acts).toEqual([{ t: 'act', n: 1, act: { kind: 'open', ref: 'agents.log#L3' } }, { t: 'act', n: 2, act: { kind: 'ask', ref: 'agents.log#L3', text: 'Restarted payments-2' } }])
    // every frame says the last event it answers, which thimble waits for
    expect(last().ack).toBe(2)
  })

  test('a fetch is a query with an id; an answer resolves it; a newer fetch with the same key drops the older one', async () => {
    const got: unknown[] = []
    const a = kit.fetch({ op: 'x' }, { key: 'k' }).catch((e: Error) => got.push(e.name))
    const b = kit.fetch({ op: 'y' }, { key: 'k' }).then((v: unknown) => got.push(v))
    const qs = sent.filter((m) => m.t === 'query')
    expect(qs.map((q) => q.q)).toEqual([{ op: 'x' }, { op: 'y' }])
    expect(sent.find((m) => m.t === 'cancel')).toEqual({ t: 'cancel', id: qs[0]!.id })
    kit.handle({ t: 'answer', id: qs[1]!.id, data: { rows: 3 } })
    await Promise.all([a, b])
    expect(got).toEqual(['AbortError', { rows: 3 }])
  })
})

describe('Color by', () => {
  const FIELDS = [
    { name: 'kind', title: 'Kind', description: 'What happened', meanings: { fired: 'An alert started firing' } },
    { name: 'source', title: 'Source', values: ['alert', 'deploy'] },
  ]

  test('the top row: Color by, the choice, its values as chips with their counts; a click turns a value\'s hue off and its records stay', async () => {
    let heard = 0
    const colour = kit.colorBy({ fields: FIELDS, onChange: () => heard++ })
    kit.draw((d: any) => colour.draw(d))
    colour.counts({ fired: 12, resolved: 10, '': 2 })
    await tick()
    expect(text()[0]).toMatch(/^ {2}Color by {2}Kind {2}● fired 12 {2}● resolved 10 {2}● no kind 2$/)
    expect(colour.query()).toEqual({ field: 'kind' })
    const fired = last().lines[0].find((s: any) => s.s === '●')
    expect(fired.fg).toBe(kit.SERIES[0])
    const off = () => colour.values.filter((v: any) => !v.on).map((v: any) => v.value)
    await click('fired')
    expect(colour.isOn('fired')).toBe(false)
    expect(off()).toEqual(['fired'])
    expect(text()[0]).toContain('○ fired 12')
    expect(heard).toBe(1)
    // Color by only colors: the value's records stay (keeps), drawn dim with no hue, and the reader hears no value off
    expect(colour.keeps({ kind: 'fired' })).toBe(true)
    expect(colour.colourOf('fired')).toBeNull()
    expect(colour.colourOf('resolved')).toBe(kit.SERIES[1])
    expect(colour.dot('fired')).toEqual({ s: '●', d: true })
    expect(colour.dot('resolved')).toEqual({ s: '●', fg: kit.SERIES[1] })
    expect(colour.query()).toEqual({ field: 'kind' })
    // Reset shows while a value is off, and puts it back
    expect(text()[0]).toMatch(/reset$/)
    await click('reset')
    expect(off()).toEqual([])
    expect(colour.colourOf('fired')).toBe(kit.SERIES[0])
    // the choice and the values turned off are kept for the view
    expect(sent.filter((m) => m.t === 'state').at(-1)!.state.colour).toEqual({ by: 'field:kind', picks: ['field:kind'], off: [], seen: [] })
  })

  test('a chip\'s tip says what its value means; values past six share one chip, `other`, with no hue of their own', async () => {
    const colour = kit.colorBy({ fields: FIELDS })
    kit.draw((d: any) => colour.draw(d))
    init({ cols: 200 })
    const c2 = kit.colorBy({ fields: FIELDS })
    kit.draw((d: any) => c2.draw(d))
    c2.counts(Object.fromEntries(['fired', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((v, i) => [v, 20 - i])))
    await tick()
    const row = text()[0]
    expect(row).toContain('● other 27')
    expect(c2.colourOf('g')).toBe('inactive')
    expect(c2.colourOf('fired')).toBe(kit.SERIES[0])
    const hit = last().hits.find((h: any) => row.slice(h.x0, h.x1).includes('fired'))
    expect(hit.tip).toBe('fired: An alert started firing')
    void colour
  })

  test('`other` with no records once the counts are in is left out, as a value with none is, unless one of its values is off', async () => {
    init({ cols: 200 })
    const colour = kit.colorBy({ fields: FIELDS })
    kit.draw((d: any) => colour.draw(d))
    colour.counts(Object.fromEntries(['fired', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((v, i) => [v, 20 - i])))
    await tick()
    expect(text()[0]).toContain('● other 27')
    // a narrower fetch: the values past six have no records in it
    colour.counts({ fired: 3, b: 2 })
    await tick()
    expect(text()[0]).toMatch(/● fired 3 {2}● b 2$/)
    colour.toggle('g')
    colour.counts({ fired: 3, b: 2 })
    await tick()
    expect(text()[0]).toContain('other 0')
  })

  test('c opens the menu: Off, the fields, then the labels; under the chosen label its definition and a link to its panel; Enter colors by it', async () => {
    const colour = kit.colorBy({ fields: FIELDS })
    kit.draw((d: any) => colour.draw(d))
    await tick()
    // the top row shows Color by as a control, so the hint row leaves its key to ?
    expect(last().hints).toEqual(['? for all keys'])
    expect(last().keys).toContain('c')
    await key('c')
    // in a frame over the rows under the top row, Color by in its edge
    expect(text()[1]).toMatch(/^ {2}╭─ Color by ─+╮$/)
    let rows = menu()
    // under the chosen field, what it is; the others' values in words
    // ● before the choice in use, ○ before the others
    expect(rows.map((r: string) => r.trim().split(/\s{2,}/)[0])).toEqual(['○ Off', 'fields', '❯ ● Kind', 'What happened', '○ Source', 'labels', '○ Database connections'])
    expect(rows.find((r: string) => r.includes('Source'))).toMatch(/Source\s+alert · deploy$/)
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to color by it alone', 'Space to check or uncheck', '? for all keys'])
    expect(last().keys).toContain('c')
    for (let i = 0; i < 3; i++) await key('down')
    rows = menu()
    // a label's values named as its chips name them: those it colors by, then `not marked`
    expect(rows.find((r: string) => r.startsWith('❯ ○ Database connections'))).toMatch(/connections · not marked\s+regex$/)
    expect(rows.find((r: string) => r.includes('definition ↗'))).toContain('regex · "(?i)connections?"')
    await click('definition')
    expect(sent.filter((m) => m.t === 'act').at(-1)!.act).toEqual({ kind: 'label', id: 'k1', name: 'Database connections' })
    // the menu stays open on the label (the panel showed the label's own meanwhile)
    await key('return')
    expect(colour.by).toEqual({ label: 'k1', title: 'Database connections' })
    expect(colour.query()).toEqual({ label: 'k1', name: 'Database connections' })
    // the label's values take the hues in order, its catch-all last value dim; its name's ↗ opens its panel
    expect(colour.colourOf('connections')).toBe(kit.SERIES[0])
    expect(colour.colourOf('other')).toBe('inactive')
    expect(text()[0]).toMatch(/Color by {2}Database connections ↗/)
    // a query names the label colored by, so the reader's labels hold it although it is not on in Files
    kit.fetch({ op: 'x' })
    expect(sent.filter((m) => m.t === 'query').at(-1)!.labels).toEqual(['k1'])
  })

  test('a label the workspace no longer has gives way to the first field', async () => {
    init({ state: { colour: { by: 'label:gone', off: ['x'] } } })
    const colour = kit.colorBy({ fields: FIELDS })
    expect(colour.by).toEqual({ field: 'kind', title: 'Kind' })
    expect(colour.query()).toEqual({ field: 'kind' })
    expect(colour.values.every((v: any) => v.on)).toBe(true)
  })

  // a label as thimble lists it: its values with whether each colors (a regex label's `other` does not), on in Files
  const ON = [
    { id: 'k1', name: 'Database connections', kind: 'regex', text: '', spec: '(?i)connections?', scope: '', values: [{ name: 'connections', highlight: true, n: 22 }, { name: 'other', highlight: false, n: 176 }], here: true, on: true },
    { id: 'k2', name: 'Charged twice', kind: 'regex', text: '', spec: 'charged twice', scope: '', values: [{ name: 'charged twice', highlight: true, n: 3 }, { name: 'other', highlight: false, n: 195 }], here: true, on: false },
  ]

  test('the view opens colored by a label that is on, as in the browser: its values as chips with counts, then not marked; one turned on later takes the color', async () => {
    init({ labels: ON })
    let heard = 0
    const colour = kit.colorBy({ fields: FIELDS, onChange: () => heard++ })
    kit.draw((d: any) => colour.draw(d))
    colour.counts({ connections: 22, '': 176 })
    await tick()
    expect(colour.by).toEqual({ label: 'k1', title: 'Database connections' })
    expect(text()[0]).toBe('  Color by  Database connections ↗  ● connections 22  ● not marked 176')
    expect(kit.changed()).toBe(false)
    // Charged twice turned on in Files: it takes the color, the one turned on last
    kit.handle({ t: 'labels', labels: ON.map((l) => ({ ...l, on: true })) })
    await tick()
    expect(colour.by).toEqual({ label: 'k2', title: 'Charged twice' })
    expect(heard).toBe(1)
    // another view opening keeps what it saw: nothing new is on, so its choice stays
    init({ labels: ON.map((l) => ({ ...l, on: true })), state: { colour: { by: 'field:kind', off: [], seen: ['k1', 'k2'] } } })
    expect(kit.colorBy({ fields: FIELDS }).by).toEqual({ field: 'kind', title: 'Kind' })
  })

  test('Reset puts back Color by as the view opens, and shows after any change from it', async () => {
    init({ labels: ON })
    const colour = kit.colorBy({ fields: FIELDS })
    kit.draw((d: any) => colour.draw(d))
    await tick()
    expect(text()[0]).not.toMatch(/reset$/)
    colour.choose('kind')
    await tick()
    expect(text()[0]).toMatch(/reset$/)
    expect(last().keys).toContain('r')
    await key('r')
    expect(colour.by).toEqual({ label: 'k1', title: 'Database connections' })
    expect(text()[0]).not.toMatch(/reset$/)
  })

  test('in a narrow panel Color by takes a row of its own under the row\'s other controls, its name whole, and its chips the row under that where none fits beside it', async () => {
    init({ cols: 45, labels: ON })
    const colour = kit.colorBy({ fields: FIELDS })
    const q = kit.search({ words: 'search events' })
    const inc = kit.choice({ title: 'incident', all: 'all', key: 'i', values: ['INC-311'] })
    kit.draw((d: any) => colour.draw(d, (r: any) => {
      q.add(r).gap()
      inc.add(r).gap()
    }))
    colour.counts({ connections: 22, '': 176 })
    await tick()
    expect(text().slice(0, 3)).toEqual(['  / search events  incident  all', '  Color by  Database connections ↗', '    ● connections 22  ● not marked 176'])
    // the chips still turn their values off
    await click('not marked')
    expect(colour.isOn(null)).toBe(false)
    expect(colour.values.filter((v: any) => !v.on).map((v: any) => v.value)).toEqual([null])
    // Reset stands at R on the top row
    expect(text()[0]).toMatch(/ {2}reset$/)
  })

  test('the menu: in a frame, the chosen field\'s values with their dots, the others\' in words, those of a field with none declared from the records the list drew; what it is said once', async () => {
    init({ cols: 90, rows: 24 })
    const fields = [{ name: 'kind', title: 'Kind', description: 'What happened' }, { name: 'service', title: 'Service', description: 'The service it is about' }]
    const colour = kit.colorBy({ fields })
    const list = kit.list({ key: (e: any) => e.id })
    const items = [{ id: 1, kind: 'fired', service: 'web' }, { id: 2, kind: 'resolved', service: 'payments' }, { id: 3, kind: 'fired', service: 'payments' }]
    kit.draw((d: any) => {
      colour.draw(d)
      list.draw(d, { items, colour, row: (e: any, r: any) => r.add(e.kind) })
    })
    colour.counts({ fired: 2, resolved: 1 })
    await tick()
    await key('c')
    const rows = menu()
    const kind = rows.find((r: string) => r.includes('Kind'))!
    expect(kind).toMatch(/❯ ● Kind\s+● fired {2}● resolved$/)
    expect(rows.find((r: string) => r.includes('Service'))).toMatch(/Service\s+payments · web$/)
    expect(rows.filter((r: string) => r.includes('What happened')).length).toBe(1)
    expect(rows.some((r: string) => r.includes('The service it is about'))).toBe(false)
    // a dot only on the chosen field's values
    const boxed = last().lines.filter((l: any) => l.some((sg: any) => sg.s.includes('Service')))[0]
    expect(boxed.some((sg: any) => sg.s.includes('●'))).toBe(false)
  })

  test('in a narrow menu a label\'s values and definition stand under its name, and `definition ↗` keeps its ↗', async () => {
    init({ cols: 47, rows: 24, labels: ON })
    const colour = kit.colorBy({ fields: FIELDS })
    kit.draw((d: any) => colour.draw(d))
    await tick()
    await key('c')
    const rows = menu()
    const at = rows.findIndex((r: string) => r.startsWith('❯ ● Database connections'))
    expect(rows[at + 1].trim()).toBe('● connections  ● not marked')
    expect(rows.slice(at + 1).some((r: string) => r.trim().endsWith('definition ↗'))).toBe(true)
    expect(rows.every((r: string) => r.length <= 43)).toBe(true)
  })
})

describe('Color by takes several choices', () => {
  const FIELDS = [
    { name: 'kind', title: 'Kind', description: 'What happened' },
    { name: 'service', title: 'Service' },
  ]
  const ITEMS = Array.from({ length: 40 }, (_, i) => ({ id: i, kind: i < 20 ? 'fired' : 'resolved', service: i % 2 ? 'web' : 'db' }))
  const huesIn = (f = last()) => new Set(f.lines.flat().map((sg: any) => sg.fg).filter((c: any) => kit.SERIES.includes(c)))

  test('Space checks a second choice, a track beside the list\'s in its own hues; Enter takes one alone', async () => {
    init({ cols: 80, rows: 16 })
    const colour = kit.colorBy({ fields: FIELDS })
    const list = kit.list({ key: (e: any) => e.id })
    kit.draw((d: any) => {
      colour.draw(d)
      list.draw(d, { items: ITEMS, colour, row: (e: any, r: any) => r.add(e.kind) })
    })
    colour.counts({ fired: 20, resolved: 20 })
    await tick()
    const cols = () => text().slice(1).map((r: string) => r.slice(-3))
    const before = cols()
    await key('c')
    await key('down')
    await key('space')
    // the menu stays open, both checked, the second a track
    let rows = menu()
    expect(rows.find((r: string) => r.includes('Service'))).toMatch(/^❯ ● Service.*track$/)
    expect(colour.picks).toEqual([{ field: 'kind', title: 'Kind' }, { field: 'service', title: 'Service' }])
    expect(colour.by).toEqual({ field: 'kind', title: 'Kind' })
    expect(text()[0]).toMatch(/^ {2}Color by {2}Kind \+1/)
    await key('c')
    // the list's track has a column more, Service's
    expect(cols()).not.toEqual(before)
    expect(colour.tracks.map((t: any) => t.title)).toEqual(['Service'])
    const lane = last().lines.slice(1, 10).map((l: any) => l.at(-2)?.fg ?? l.at(-1)?.fg)
    expect(lane.some((c: any) => kit.SERIES.includes(c))).toBe(true)
    // Enter on a choice takes it alone
    await key('c')
    rows = menu()
    await key('return')
    expect(colour.picks.length).toBe(1)
  })

  test("each row has a mark per choice, as the browser's bands on its edge: its value's `●` of the first, then of each past it, a space where it has none; Off has one dim mark", async () => {
    init({ cols: 80, rows: 16, state: { colour: { by: 'field:kind', picks: ['field:kind', 'field:service'], off: [], seen: [] } } })
    const colour = kit.colorBy({ fields: FIELDS })
    const list = kit.list({ key: (e: any) => e.id })
    const items = [{ id: 1, kind: 'fired', service: 'db' }, { id: 2, kind: 'fired', service: 'web' }, { id: 3, kind: 'resolved' }, { id: 4, service: 'web' }]
    kit.draw((d: any) => {
      colour.draw(d)
      list.draw(d, { items, colour, header: (r: any) => r.add('kind'), row: (e: any, r: any) => r.add(e.kind || '-') })
    })
    colour.counts({ fired: 2, resolved: 1 })
    await tick()
    expect(colour.picks.map((p: any) => p.title)).toEqual(['Kind', 'Service'])
    const service = colour.tracks[0]
    const lines = () => last().lines.slice(1)
    // the header's names over the rows' words, past both marks and the gap
    expect(text()[1]).toBe('     kind')
    expect(text().slice(2, 6)).toEqual(['❯ ●● fired', '  ●● fired', '  ●  resolved', '  ●● -'])
    // each `●` of a row, by its style: a run may hold two of one hue
    const dots = (l: any[]) => l.flatMap((sg: any) => [...sg.s].filter((ch) => ch === '●').map(() => (sg.d ? 'dim' : sg.fg)))
    const [, one, two, three, four] = lines()
    expect(dots(one)).toEqual([colour.colourOf('fired'), service.colourOf('db')])
    // the second mark is the service's hue, not the kind's
    expect(dots(two)).toEqual([colour.colourOf('fired'), service.colourOf('web')])
    expect(service.colourOf('web')).not.toBe(colour.colourOf('fired'))
    // no service: the kind's mark alone, a space in the service's cell
    expect(dots(three)).toEqual([colour.colourOf('resolved')])
    // no kind: the kind's dim mark, then the service's
    expect(dots(four)).toEqual(['dim', service.colourOf('web')])
    // Off: one mark, dim, and no cell for the track
    colour.choose(null)
    await tick()
    expect(text().slice(2, 6)).toEqual(['❯ ● fired', '  ● fired', '  ● resolved', '  ● -'])
    expect(lines().slice(1, 5).map(dots)).toEqual([['dim'], ['dim'], ['dim'], ['dim']])
  })

  test('with Off, the track and every mark the kit draws carry no hue, a label on or not', async () => {
    init({ cols: 80, rows: 16, labels: [{ id: 'k1', name: 'Asks', kind: 'regex', values: [{ name: 'yes', highlight: true }], here: true, on: true }], state: { colour: { by: 'off', picks: [], off: [], seen: ['k1'] } } })
    const colour = kit.colorBy({ fields: FIELDS })
    const list = kit.list({ key: (e: any) => e.id })
    kit.draw((d: any) => {
      colour.draw(d)
      list.draw(d, { items: ITEMS, colour, row: (e: any, r: any) => r.add(e.kind) })
    })
    await tick()
    expect(colour.off).toBe(true)
    expect(text()[0]).toMatch(/Color by {2}Off/)
    expect([...huesIn()]).toEqual([])
    // the track is there, in the dim alone
    expect(text().slice(1).some((r: string) => r.endsWith('▌'))).toBe(true)
  })

  test("a group's mix: its records' share of each value in the value's hue, a value turned off dim, none for Off", async () => {
    init({ cols: 80 })
    const colour = kit.colorBy({ fields: FIELDS })
    colour.counts({ fired: 3, resolved: 1 })
    const runs = colour.mix({ fired: 3, resolved: 1, '': 4 }, 8)
    expect(runs.map((r: any) => r.s.length)).toEqual([3, 1, 4])
    expect(runs[0].fg).toBe(colour.colourOf('fired'))
    expect(runs[2].d).toBe(true)
    // a value turned off keeps its share, dim as the records with no value
    colour.toggle('fired')
    const off = colour.mix({ fired: 3, resolved: 1, '': 4 }, 8)
    expect(off.map((r: any) => r.s.length)).toEqual([3, 1, 4])
    expect(off[0]).toEqual({ s: '███', d: true })
    expect(off[1].fg).toBe(colour.colourOf('resolved'))
    colour.choose(null)
    expect(colour.mix({ fired: 3 })).toEqual([])
  })

  test('"+N" opens the values the row has no room for, each with its dot, its toggle and what it means', async () => {
    init({ cols: 46, rows: 20 })
    const fields = [{ name: 'kind', title: 'Kind', meanings: { 'paged someone': 'the alert paged the on-call' } }]
    const colour = kit.colorBy({ fields })
    kit.draw((d: any) => colour.draw(d))
    colour.counts({ fired: 9, resolved: 8, 'paged someone': 7, acknowledged: 6 })
    await tick()
    const more = text().join('\n').match(/\+(\d+)/)
    expect(more, text().join('\n')).not.toBeNull()
    await click(more![0])
    const rows = menu()
    const shown = colour.values.length - Number(more![1])
    const hidden = colour.values.slice(shown).map((v: any) => v.name)
    expect(rows.filter((r: string) => /[●○]/.test(r)).map((r: string) => r.replace(/^❯ /, '').trim().split(/\s{2,}/)[0])).toEqual(hidden.map((n: string) => `● ${n}`))
    // under the chosen one what it means; Space turns it off and the menu stays
    const target = hidden[0]
    await key('space')
    expect(colour.isOn(target)).toBe(false)
    expect(menu().some((r: string) => r.includes(`○ ${target}`))).toBe(true)
    expect(last().hints).toContain('Space to turn off or on')
  })
})

describe('the time range', () => {
  const T0 = Date.UTC(2026, 4, 16) / 1000
  const times = Array.from({ length: 100 }, (_, i) => T0 + i * 3600)

  test('it opens on the whole span; the readout gives its start, end and length; the strip a cell per bin', async () => {
    const range = kit.timeRange({})
    range.data({ times })
    kit.draw((d: any) => range.draw(d, { gutter: 8 }))
    await tick()
    expect(range.full).toBe(true)
    expect(text()[0]).toBe('  16 May 00:00 – 20 May 03:00 · 4d 3h')
    expect(text()[1].length).toBe(2 + 8 + 72)
    // the mouse moves it: it binds no key
    expect(last().keys).toEqual([])
    expect(last().hints).toEqual([])
  })

  test('zoomed in, the window is on the selection background and the rest dim; a click moves it; it is kept; the signs that panned and zoomed do nothing', async () => {
    const range = kit.timeRange({})
    range.data({ times })
    kit.draw((d: any) => range.draw(d))
    await tick()
    expect(last().hits.find((h: any) => h.drag).tip).toBe('drag to frame a range')
    const f = last()
    kit.handle({ t: 'drag', i: f.hits.findIndex((h: any) => h.drag), seq: f.seq, x0: 30, x1: 59, n: ++n })
    await tick()
    expect(range.full).toBe(false)
    const from = range.from
    const to = range.to
    for (const k of ['[', ']', '+', '-', '{', '}']) await key(k)
    expect([range.from, range.to]).toEqual([from, to])
    const strip = last().lines[1]
    expect(strip.some((s: any) => s.bg === 'selectionBg')).toBe(true)
    expect(strip.some((s: any) => s.d && !s.bg)).toBe(true)
    // the window's edges are `[` `]`, the cells a drag moves them from
    const row = text()[1]
    expect(row.indexOf('[')).toBeGreaterThan(2)
    expect(row.indexOf(']')).toBeGreaterThan(row.indexOf('['))
    expect(strip.find((s: any) => s.s.includes('[')).bg).toBe('selectionBg')
    expect(sent.filter((m) => m.t === 'state').at(-1)!.state.ranges.time).toEqual([range.from, range.to])
    await click(text()[1].trim().slice(0, 1), 0)
    expect(range.from).toBeLessThan(from)
  })

  test('a drag outside the window frames a new range; from inside it moves the window', async () => {
    const range = kit.timeRange({})
    range.data({ times })
    kit.draw((d: any) => range.draw(d))
    await tick()
    const f = last()
    const strip = f.hits.findIndex((h: any) => h.drag)
    kit.handle({ t: 'drag', i: strip, seq: f.seq, x0: 10, x1: 20, n: ++n })
    await tick()
    const s0 = range.span[0]
    const step = (range.span[1] - range.span[0]) / 80
    expect(range.from).toBeCloseTo(s0 + 10 * step, -2)
    expect(range.to).toBeCloseTo(s0 + 21 * step, -2)
    const g = last()
    kit.handle({ t: 'drag', i: g.hits.findIndex((h: any) => h.drag), seq: g.seq, x0: 15, x1: 25, n: ++n })
    await tick()
    expect(range.from).toBeCloseTo(s0 + 20 * step, -2)
  })

  test('the scale lays the range across the chart\'s cells; its ticks keep apart and date the first and a new day', () => {
    const range = kit.timeRange({})
    range.data({ times })
    const sc = range.scale(100)
    expect(sc.x(times[0])).toBe(0)
    expect(sc.x(times.at(-1))).toBe(99)
    expect(sc.binOf(times[0] - 10)).toBe(-1)
    const ticks = sc.ticks(12)
    expect(ticks[0].label).toMatch(/^\d+ May \d\d:00$/)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(12)
    expect(ticks.some((t: any) => /^17 May/.test(t.label))).toBe(true)
  })

  test('with gap, an empty stretch longer than it is a break: each stretch takes its share of the cells, a break 4, drawn // on the strip and the axis', async () => {
    // three bursts of 40 minutes, the second 2 hours after the first and the third the next morning
    const burst = (t: number) => Array.from({ length: 41 }, (_, i) => t + i * 60)
    const B = [T0 + 14 * 3600, T0 + 17 * 3600, T0 + 33 * 3600]
    const ts = [...burst(B[0]!), ...burst(B[1]!), ...burst(B[2]!)]
    init({ cols: 100 })
    const range = kit.timeRange({ gap: 1200 })
    range.data({ times: ts })
    const sc = range.scale(100)
    expect(sc.broken).toBe(true)
    expect(sc.gaps()).toEqual([[31, 35], [66, 70]])
    expect(sc.x(B[0])).toBe(0)
    expect(sc.x(B[0]! + 2400)).toBe(30)
    expect(sc.x(B[1])).toBe(35)
    expect(sc.x(B[2]! + 2400)).toBe(99)
    expect(sc.binOf(B[0]! + 3 * 3600)).toBeGreaterThanOrEqual(31)
    // the first tick of each stretch gives its date
    const ticks = sc.ticks(8)
    expect(ticks.filter((t: any) => / \d\d:\d\d$/.test(t.label) && /May/.test(t.label)).map((t: any) => t.label)).toEqual(['16 May 14:00', '16 May 17:00', '17 May 09:00'])
    kit.draw((d: any) => {
      range.draw(d, { gutter: 0 })
      kit.axis(d, range.scale(d.cols), { gap: 8 })
    })
    await tick()
    const rows = text()
    expect(rows[1].slice(2 + 31, 2 + 35)).toBe(' // ')
    expect(rows[1].slice(2 + 66, 2 + 70)).toBe(' // ')
    expect(rows[2].slice(2 + 32, 2 + 34)).toBe('//')
    expect(rows[2]).toContain('17 May 09:00')
    expect(last().lines[2].find((s: any) => s.s === '//').fg).toBe('subtle')
    // a legend stands whole in the gutter before the ticks, leaving a gutter's space; none where it has no room
    const legend = [{ s: '─', fg: 'subtle' }, { s: ' running  × failed', d: true }]
    kit.draw((d: any) => kit.axis(d, range.scale(d.cols - 22), { gutter: 22, gap: 8, legend }))
    await tick()
    expect(text()[0]).toMatch(/^ {2}─ running {2}× failed {4}16 May 14:00/)
    expect(last().lines[0][1]).toMatchObject({ s: '─', fg: 'subtle' })
    kit.draw((d: any) => kit.axis(d, range.scale(d.cols - 12), { gutter: 12, gap: 8, legend }))
    await tick()
    expect(text()[0]).toMatch(/^ +16 May 14:00/)
    // a stretch with no room for a time and its date gives the date alone
    init({ cols: 40 })
    const narrow = kit.timeRange({ gap: 1200 })
    narrow.data({ times: ts })
    kit.draw((d: any) => kit.axis(d, narrow.scale(d.cols), { gap: 4 }))
    await tick()
    expect(text()[0].split(/\s+/).filter(Boolean)).toEqual(['16', 'May', '//', '16', 'May', '//', '17', 'May'])
  })

  test('data with no record keeps the span and its breaks, as the browser does, so the axis does not jump to 1970', () => {
    const burst = (t: number) => Array.from({ length: 41 }, (_, i) => t + i * 60)
    const range = kit.timeRange({ gap: 1200 })
    range.data({ times: [...burst(T0), ...burst(T0 + 5 * 3600)] })
    const span = range.span
    range.data({ times: [] })
    expect(range.span).toEqual(span)
    expect(range.scale(80).broken).toBe(true)
    expect(range.readout()).toMatch(/^16 May 00:00 – 05:40/)
  })

  test('on a broken scale an edge never stays in a break, and a drag moves the window across one', async () => {
    const burst = (t: number) => Array.from({ length: 41 }, (_, i) => t + i * 60)
    const B = [T0 + 14 * 3600, T0 + 17 * 3600, T0 + 33 * 3600]
    const range = kit.timeRange({ gap: 1200 })
    range.data({ times: [...burst(B[0]!), ...burst(B[1]!), ...burst(B[2]!)] })
    kit.draw((d: any) => range.draw(d))
    await tick()
    // a range from inside the first break to inside the second: its start moves to the second burst, its end to its end
    range.set(B[0]! + 3600, B[1]! + 4 * 3600)
    expect(range.from).toBe(B[1])
    expect(range.to).toBe(B[1]! + 2400)
    // a drag from inside the window moves it right, past the break into the third burst
    await tick()
    const before = [range.from, range.to]
    const row = text()[1].slice(2)
    const g = last()
    const mid = Math.floor((row.indexOf('[') + row.indexOf(']')) / 2)
    kit.handle({ t: 'drag', i: g.hits.findIndex((h: any) => h.drag), seq: g.seq, x0: mid, x1: mid + 30, n: ++n })
    await tick()
    expect(range.from).toBeGreaterThan(before[0]!)
    expect(range.to).toBeGreaterThan(before[1]!)
    for (const t of [range.from, range.to]) {
      const inBreak = (t > B[0]! + 2400 && t < B[1]!) || (t > B[1]! + 2400 && t < B[2]!)
      expect(inBreak).toBe(false)
    }
  })

  test('with a gap, bursts a day apart share the strip and the scale, and each burst\'s first tick gives its date', async () => {
    // three bursts of five hours, a day apart
    const bursts = [0, 1, 2].flatMap((day) => Array.from({ length: 6 }, (_, h) => T0 + day * 86400 + (9 + h) * 3600))
    const range = kit.timeRange({ gap: 4 * 3600 })
    range.data({ times: bursts })
    kit.draw((d: any) => {
      range.draw(d)
      kit.axis(d, range.scale(d.cols))
    })
    await tick()
    const sc = range.scale(80)
    expect(sc.broken).toBe(true)
    const gaps = sc.gaps()
    // two breaks, the three bursts in the cells between them, about a third of the strip each
    expect(gaps.length).toBe(2)
    expect(gaps[0][0]).toBeGreaterThan(20)
    expect(gaps[1][1]).toBeLessThan(60)
    const strip = text()[1].slice(2)
    for (const [g0, g1] of gaps) expect(strip.slice(g0, g1)).toBe(' // ')
    expect(sc.x(bursts[0])).toBe(0)
    expect(sc.x(bursts[5])).toBe(gaps[0][0] - 1)
    expect(sc.x(bursts[6])).toBe(gaps[0][1])
    expect(sc.x(bursts.at(-1))).toBe(79)
    // each burst's first tick gives its date; the axis draws the breaks and no label runs into one
    const days = sc.ticks(8).filter((t: any) => / May /.test(t.label)).map((t: any) => t.label.split(' ')[0])
    expect(days).toEqual(['16', '17', '18'])
    for (const [g0] of gaps) expect(text()[2].slice(2 + g0 + 1, 2 + g0 + 3)).toBe('//')
    // zoomed to the first burst, the range's scale has no break
    range.set(bursts[0], bursts[5])
    expect(range.scale(80).broken).toBe(false)
  })
})

describe('the list', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: i, kind: i % 3 ? 'fired' : 'resolved', text: `event ${i}` }))

  test('↑↓ choose (❯ and the accent), the chosen row stays in view, Enter opens its details in place at A2, the track shows the part in view', async () => {
    init({ rows: 12 })
    const colour = kit.colorBy({ fields: [{ name: 'kind', title: 'Kind' }] })
    const list = kit.list({ key: (e: any) => e.id })
    const opened: number[] = []
    kit.draw((d: any) => list.draw(d, {
      items: [{ heading: 'Sat 16 May 2026' }, ...items],
      colour,
      row: (e: any, r: any) => r.add(e.text),
      detail: (e: any, dd: any) => kit.details(dd, { text: `all of ${e.text}`, facts: [['kind', e.kind]], place: `log.txt#L${e.id + 1}` }),
      onOpen: (e: any) => opened.push(e.id),
      ask: (e: any) => ({ ref: `log.txt#L${e.id + 1}`, text: e.text }),
    }))
    await tick()
    let rows = text()
    expect(rows[0]).toMatch(/^ {2}Sat 16 May 2026/)
    expect(last().lines[0][1]).toMatchObject({ b: true })
    expect(rows[1]).toMatch(/^❯ ● event 0/)
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to open', '? for all keys'])
    expect(last().keys).toContain('a')
    for (let i = 0; i < 15; i++) await key('down')
    rows = text()
    expect(rows.length).toBe(12)
    expect(rows.find((r: string) => r.startsWith('❯'))).toMatch(/event 15/)
    // the track: a column at the right edge, the part in view on the selection background
    const right = last().lines.map((l: any) => l.at(-1))
    expect(right.every((s: any) => s.s === '▌' || s.s === ' ')).toBe(true)
    expect(right.filter((s: any) => s.bg === 'selectionBg').length).toBeGreaterThan(0)
    expect(right.filter((s: any) => s.bg === 'selectionBg').length).toBeLessThan(12)
    await key('return')
    rows = text()
    const at = rows.findIndex((r: string) => r.startsWith('❯'))
    expect(rows[at + 1]).toMatch(/^ {4}all of event 15/)
    expect(rows[at + 2]).toMatch(/^ {4}kind resolved/)
    expect(rows[at + 3]).toMatch(/^ {4}↗ log\.txt line 16/)
    expect(opened).toEqual([15])
    expect(last().hints).toContain('Enter to close')
    await click('log.txt line 16')
    expect(sent.filter((m) => m.t === 'act').at(-1)!.act).toEqual({ kind: 'open', ref: 'log.txt#L16' })
    await key('a')
    expect(sent.filter((m) => m.t === 'act').at(-1)!.act).toEqual({ kind: 'ask', ref: 'log.txt#L16', text: 'event 15' })
  })

  test('the chosen row is in the accent across its whole width, its dim columns too; a value\'s hue keeps its own', async () => {
    const colour = kit.colorBy({ fields: [{ name: 'kind', title: 'Kind' }] })
    const list = kit.list({ key: (e: any) => e.id })
    kit.draw((d: any) => list.draw(d, { items, colour, row: (e: any, r: any) => r.add(String(e.id), { d: true }).gap().add(e.text) }))
    colour.counts({ fired: 26, resolved: 14 })
    await tick()
    const chosen = last().lines[0]
    expect(chosen.find((s: any) => s.s === '●').fg).toBe(colour.colourOf('resolved'))
    for (const s of chosen.filter((x: any) => x.s.trim() && x.s !== '●' && x.s !== '❯ ' && x.s !== '▌')) expect([s.s, s.fg, s.d]).toEqual([s.s, 'suggestion', undefined])
    // a strip's cell whose value has no hue of its own (past six) is dim, never the text's color
    const sc = { cols: 3, binOf: (t: number) => t, step: 1 }
    const c2 = kit.colorBy({ fields: [{ name: 'k', title: 'K' }] })
    c2.counts(Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((v, i) => [v, 10 - i])))
    expect(kit.strip(sc, [{ t: 0, k: 'g' }], { value: (it: any) => it.k, colour: c2 })[0]).toMatchObject({ d: true })
  })

  test('a table: the columns\' names above the rows, dim, ▼ after the one sorted by, a click on a name sorts by it', async () => {
    init({ cols: 40, rows: 8 })
    const list = kit.list({ key: (e: any) => e.id })
    let sorted = 1
    kit.draw((d: any) => {
      const cols = kit.columns([{ w: 8 }, { w: 6, align: 'right' }, { grow: true }], d.cols - 2)
      const rows = [...items.slice(0, 3)].sort((a, b) => (sorted === 1 ? b.id - a.id : a.text.localeCompare(b.text)))
      list.draw(d, {
        items: rows,
        header: (r: any) => cols.header(r, ['kind', 'id', 'text'], { sorted, onSort: (i: number) => (sorted = i) }),
        row: (e: any, r: any) => cols.cells(r, [e.kind, e.id, e.text]),
      })
    })
    await tick()
    expect(text()[0]).toBe('  kind        id ▼  text')
    expect(last().lines[0].find((s: any) => s.s.includes('kind')).d).toBe(true)
    expect(text()[1]).toMatch(/^❯ fired {10}2 {2}event 2/)
    await click('text')
    expect(text()[0]).toBe('  kind          id  text ▼')
    expect(text()[1]).toMatch(/event 0/)
  })

  test("a list many times taller than its rows keeps one track column at its right edge, as the browser's one strip, with no zoomed column beside it", async () => {
    init({ rows: 10 })
    const colour = kit.colorBy({ fields: [{ name: 'kind', title: 'Kind' }] })
    const list = kit.list({ key: (e: any) => e.id })
    const many = Array.from({ length: 400 }, (_, i) => ({ id: i, kind: i < 200 ? 'fired' : 'resolved', text: `event ${i}` }))
    kit.draw((d: any) => list.draw(d, { items: many, colour, row: (e: any, r: any) => r.add(e.text) }))
    colour.counts({ fired: 200, resolved: 200 })
    await tick()
    const f = last()
    const rows = text(f)
    expect(rows.length).toBe(10)
    // the track's cell ends each row, the cell before it the row's own
    for (const r of rows) expect([r.at(-1), r.at(-2)]).toEqual(['▌', ' '])
    // its top half in the first value's hue, its bottom half in the second's; the part in view on the selection background
    const track = f.lines.map((l: any) => l.at(-1))
    expect(new Set(track.slice(0, 5).map((s: any) => s.fg))).toEqual(new Set([colour.colourOf('fired')]))
    expect(new Set(track.slice(5).map((s: any) => s.fg))).toEqual(new Set([colour.colourOf('resolved')]))
    expect(track.map((s: any) => s.bg === 'selectionBg')).toEqual(track.map((_: any, k: number) => k === 0))
    // a hot region per row, over that one cell, that goes there
    const hits = f.hits.filter((h: any) => /^rows \d/.test(h.tip ?? ''))
    expect(hits.map((h: any) => h.y)).toEqual(rows.map((_: string, k: number) => k))
    expect(new Set(hits.map((h: any) => h.x1 - h.x0))).toEqual(new Set([1]))
    expect(f.hits.some((h: any) => h.tip === 'the rows around the view')).toBe(false)
    const i = f.hits.indexOf(hits[7])
    kit.handle({ t: 'click', i, seq: f.seq, x: 0, n: ++n })
    await tick()
    expect(text().find((r: string) => r.startsWith('❯'))).toMatch(/event 280/)
  })

  test('a list that fits has no track; one with no item says so', async () => {
    const list = kit.list({ key: (e: any) => e.id })
    kit.draw((d: any) => list.draw(d, { items: items.slice(0, 3), row: (e: any, r: any) => r.add(e.text) }))
    await tick()
    expect(text().every((r: string) => !r.includes('▌'))).toBe(true)
    kit.draw((d: any) => list.draw(d, { items: [], empty: 'no event' }))
    await tick()
    expect(text()).toEqual(['    no event'])
  })

  test('the wheel moves the rows and leaves the choice; a click on a row chooses it and opens it', async () => {
    init({ rows: 10 })
    const list = kit.list({ key: (e: any) => e.id })
    kit.draw((d: any) => list.draw(d, { items, row: (e: any, r: any) => r.add(e.text), detail: (e: any, dd: any) => dd.line(`more on ${e.text}`) }))
    await tick()
    kit.handle({ t: 'wheel', by: 5 })
    await tick()
    expect(text()[0]).toMatch(/event 5/)
    expect(list.chosen).toBe(0)
    await click('event 7')
    expect(list.chosen).toBe(7)
    expect(list.open).toBe(7)
    expect(text().some((r: string) => r.startsWith('    more on event 7'))).toBe(true)
  })

  // the frame's rows of a list's items, by their words (`page 3`, `rev 12`), and the first of them in view
  const shownOf = (word: string) => text().flatMap((r: string) => (new RegExp(`${word} (\\d+)`).exec(r) ? [Number(new RegExp(`${word} (\\d+)`).exec(r)![1])] : []))
  // the wheel over the frame's row that shows `words`, as thimble-term sends it (the cell under the pointer, its margin
  // counted), or with no cell
  async function wheel(by: number, words?: string) {
    const f = last()
    const y = words ? text(f).findIndex((r: string) => r.includes(words)) : -1
    if (words) expect(y, `a row shows ${words}`).toBeGreaterThanOrEqual(0)
    kit.handle({ t: 'wheel', by, n: ++n, ...(words ? { seq: f.seq, x: text(f)[y].indexOf(words), y } : {}) })
    await tick()
  }

  test('two lists in one view (the pages, and under them a page\'s revisions): the wheel moves the rows of the list under the pointer alone, which then has ↑↓ and Enter; a click gives a list the keys; `l` gives them to the other, named in `?` alone; else the main list has them', async () => {
    init({ cols: 60, rows: 24 })
    const pages = kit.list({ key: (p: any) => p.id })
    const revs = kit.list({ key: (r: any) => r.id, enter: 'to read it' })
    const P = Array.from({ length: 40 }, (_, i) => ({ id: i, text: `page ${i}` }))
    const R = Array.from({ length: 40 }, (_, i) => ({ id: i, text: `rev ${i}` }))
    let open = true
    kit.draw((d: any) => {
      pages.draw(d, { title: 'pages', count: 40, items: P, height: 8, row: (p: any, r: any) => r.add(p.text) })
      if (!open) return
      d.rule()
      d.line([{ s: 'dse/StartSeite', b: true }])
      revs.draw(d, { items: R, row: (x: any, r: any) => r.add(x.text) })
    })
    await tick()
    // the wheel over the revisions moves them, and the pages stay where they are
    await wheel(5, 'rev 3')
    expect(shownOf('page')[0]).toBe(0)
    expect(shownOf('rev')[0]).toBe(5)
    // the revisions have ↑↓ and Enter now
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to read it', '? for all keys'])
    await key('down')
    expect([pages.chosen, revs.chosen]).toEqual([0, 1])
    // the wheel over the pages' title, their rows or their track moves them alone
    await wheel(3, 'pages')
    await wheel(2, 'page 6')
    expect(shownOf('page')[0]).toBe(5)
    expect(shownOf('rev')[0]).toBe(1)
    await key('down')
    expect([pages.chosen, revs.chosen]).toEqual([1, 1])
    // the wheel over no list (the rule, the page's name) moves none
    await wheel(4, 'dse/StartSeite')
    expect([shownOf('page')[0], shownOf('rev')[0]]).toEqual([1, 1])
    // with no cell (`thimble view text`'s wheel:<n>), the list that has the keys
    await wheel(3)
    expect([shownOf('page')[0], shownOf('rev')[0]]).toEqual([4, 1])
    // a click on a revision chooses it and gives the revisions the keys
    await click('rev 9')
    await key('down')
    expect([pages.chosen, revs.chosen]).toEqual([1, 10])
    // `l` gives the keys to the other list: `?` names it, the hint row does not
    expect(last().keys).toContain('l')
    expect(last().hints.join(' · ')).not.toContain('other list')
    await key('?')
    expect(text().some((r: string) => /l +to choose in the other list/.test(r))).toBe(true)
    await key('l')
    await key('down')
    expect([pages.chosen, revs.chosen]).toEqual([2, 10])
    await key('l')
    await key('down')
    expect([pages.chosen, revs.chosen]).toEqual([2, 11])
    // the revisions gone (the page closed), the main list has the keys again, and `l` is bound no more
    open = false
    kit.redraw()
    await tick()
    expect(last().keys).not.toContain('l')
    await key('down')
    expect(pages.chosen).toBe(3)
    // drawn again, the main list, the first drawn, has the keys until another is clicked, scrolled or chosen
    open = true
    kit.redraw()
    await tick()
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to open', '? for all keys'])
    await key('down')
    expect([pages.chosen, revs.chosen]).toEqual([4, 11])
    // the program choosing a row gives its list the keys (a citation opened it)
    revs.show(20)
    await tick()
    await key('down')
    expect([pages.chosen, revs.chosen]).toEqual([4, 21])
  })

  test('a list in a side pane: the wheel over the pane\'s rows moves its list, the wheel over the list beside it that list; a list in a row\'s details that shows every row passes the wheel to the list around it', async () => {
    init({ cols: 100, rows: 20 })
    const pane = kit.side({ key: 'page', width: 0.5 })
    const pages = kit.list({ key: (p: any) => p.id })
    const revs = kit.list({ key: (r: any) => r.id })
    const P = Array.from({ length: 40 }, (_, i) => ({ id: i, text: `page ${i}` }))
    const R = Array.from({ length: 40 }, (_, i) => ({ id: i, text: `rev ${i}` }))
    kit.draw((d: any) => pages.draw(d, {
      items: P,
      side: pane,
      sideTitle: (p: any) => p.text,
      row: (p: any, r: any) => r.add(p.text),
      detail: (p: any, dd: any) => {
        dd.line(`facts of ${p.text}`)
        revs.draw(dd, { items: R, row: (x: any, r: any) => r.add(x.text) })
      },
    }))
    pane.show(0)
    await tick()
    expect(text()[1]).toContain('│ facts of page 0')
    await wheel(4, 'facts of page 0')
    expect([shownOf('page')[0], shownOf('rev')[0]]).toEqual([0, 4])
    await wheel(3, 'page 2')
    expect([shownOf('page')[0], shownOf('rev')[0]]).toEqual([3, 4])
    // details in place, a list in them that shows every row: the wheel over it moves the list around it
    init({ cols: 60, rows: 12 })
    const outer = kit.list({ key: (p: any) => p.id })
    const inner = kit.list({ key: (r: any) => r.id })
    kit.draw((d: any) => outer.draw(d, {
      items: P,
      row: (p: any, r: any) => r.add(p.text),
      detail: (p: any, dd: any) => inner.draw(dd, { items: R.slice(0, 3), row: (x: any, r: any) => r.add(x.text) }),
    }))
    outer.show(0)
    await tick()
    expect([shownOf('page')[0], shownOf('rev')[0]]).toEqual([0, 0])
    await wheel(2, 'rev 1')
    expect([shownOf('page')[0], shownOf('rev')[0]]).toEqual([1, 1])
  })

  test('a row its details keep in view (d.focus) shows however far down the details it is, with the chosen row where both fit', async () => {
    init({ rows: 10 })
    const list = kit.list({ key: (e: any) => e.id })
    let at = 30
    kit.draw((d: any) => list.draw(d, {
      items: items.slice(0, 5),
      row: (e: any, r: any) => r.add(e.text),
      detail: (e: any, dd: any) => {
        for (let i = 0; i < 40; i++) {
          if (i === at) dd.focus()
          dd.line(`line ${i} of ${e.text}`)
        }
      },
    }))
    list.show(2)
    await tick()
    expect(text().some((r: string) => r.includes('line 30 of event 2'))).toBe(true)
    at = 6
    kit.redraw()
    await tick()
    expect(text()[0]).toMatch(/^❯ event 2/)
    expect(text().some((r: string) => r.includes('line 6 of event 2'))).toBe(true)
  })

  test('a long list draws only its rows in view, and draws them as drawing every row does (as text, for the checks)', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: i, kind: ['fired', 'resolved', 'held'][i % 3], text: `event ${i}` }))
    const items = many.flatMap((e) => (e.id % 50 ? [e] : [{ heading: `hour ${e.id / 50}` }, e]))
    const play = async (mode: string) => {
      init({ rows: 24, text: mode })
      const colour = kit.colorBy({ fields: [{ name: 'kind', title: 'Kind' }] })
      const list = kit.list({ key: (e: any) => e.id })
      let drawn = 0
      kit.draw((d: any) => {
        drawn = 0
        list.draw(d, {
          items,
          colour,
          row: (e: any, r: any) => {
            drawn++
            r.add(e.text)
          },
          body: (e: any, bd: any) => {
            if (e.id % 7 === 0) bd.line(`the seventh, ${e.id}`)
          },
          detail: (e: any, dd: any) => dd.line(`all of ${e.text}`),
        })
      })
      await tick()
      const counts: number[] = []
      const shown: string[][] = []
      for (const k of [...Array(30).fill('down'), 'return', ...Array(3).fill('down'), ...Array(5).fill('up')]) {
        await key(k)
        counts.push(drawn)
        shown.push(text())
      }
      kit.handle({ t: 'wheel', by: 2000 })
      await tick()
      shown.push(text())
      return { counts, shown }
    }
    const live = await play('')
    // a key draws about the rows in view, never the 3,000
    expect(Math.max(...live.counts)).toBeLessThanOrEqual(30)
    const every = await play('plain')
    expect(Math.min(...every.counts)).toBe(3000)
    expect(live.shown).toEqual(every.shown)
    expect(live.shown.at(-1)).not.toEqual(live.shown.at(-2))
  })

  test('a part drawn above the list that marks its rows in view (the lanes\' span) has them in the frame that answers a key, which is the only one', async () => {
    init({ cols: 60, rows: 16 })
    const many = Array.from({ length: 300 }, (_, i) => ({ id: i, t: 1000 + i * 10 }))
    const list = kit.list({ key: (e: any) => e.id })
    let spans: any[] = []
    kit.draw((d: any) => {
      spans.push(list.span())
      d.line('the overview')
      list.draw(d, { items: many, row: (e: any, r: any) => r.add(`event ${e.id}`) })
    })
    await tick()
    for (let i = 0; i < 40; i++) {
      const before = frames().length
      spans = []
      await key('down')
      expect(frames().length).toBe(before + 1)
      expect(spans.length).toBe(1)
      const ids = text().flatMap((r: string) => (/event (\d+)/.exec(r) ? [Number(/event (\d+)/.exec(r)![1])] : []))
      expect(spans[0]).toEqual([1000 + Math.min(...ids) * 10, 1000 + Math.max(...ids) * 10])
    }
    // the wheel moves them too
    spans = []
    kit.handle({ t: 'wheel', by: 100, n: ++n })
    await tick()
    const ids = text().flatMap((r: string) => (/event (\d+)/.exec(r) ? [Number(/event (\d+)/.exec(r)![1])] : []))
    expect(spans.at(-1)).toEqual([1000 + Math.min(...ids) * 10, 1000 + Math.max(...ids) * 10])
  })

  test('colored by a label, a list of more records than one marks query answers asks for their values in parts', async () => {
    init({ rows: 20, labels: [{ ...LABELS[0], on: true }] })
    const colour = kit.colorBy({ fields: [{ name: 'kind', title: 'Kind' }] })
    const list = kit.list({ key: (e: any) => e.ref })
    const many = Array.from({ length: 4500 }, (_, i) => ({ ref: `agents.log#L${i + 1}`, text: `line ${i + 1}` }))
    kit.draw((d: any) => list.draw(d, { items: many, colour, row: (e: any, r: any) => r.add(e.text) }))
    await tick()
    await tick()
    const asked = sent.filter((m) => m.t === 'query' && m.q && m.q.$thimble === 'marks').map((m) => m.q.refs as string[])
    expect(asked.length).toBeGreaterThan(1)
    expect(Math.max(...asked.map((r) => r.length))).toBeLessThanOrEqual(2000)
    expect(new Set(asked.flat()).size).toBe(4500)
  })
})

describe('search and choices', () => {
  test('/ starts typing: the panel\'s field holds the text and sends each change whole; a key sent alone types too; Enter ends', async () => {
    const said: string[] = []
    const q = kit.search({ onChange: (t: string) => said.push(t) })
    kit.draw((d: any) => {
      const r = d.row()
      q.add(r)
      r.end()
    })
    await tick()
    expect(text()[0]).toBe('  / search')
    expect(last().hints).toEqual(['? for all keys'])
    expect(last().keys).toContain('/')
    await key('/')
    expect(last().typing).toBe(true)
    expect(last().field).toEqual({ text: '' })
    expect(last().hints).toEqual(['Enter to finish'])
    kit.handle({ t: 'text', value: 'refund', n: ++n })
    await tick()
    expect(q.text).toBe('refund')
    expect(last().field).toEqual({ text: 'refund' })
    expect(said.at(-1)).toBe('refund')
    kit.handle({ t: 'text', value: '', n: ++n })
    await tick()
    for (const k of ['d', 'b', 'x', 'space', 'q']) await key(k)
    expect(q.text).toBe('dbx q')
    await key('backspace')
    expect(said.at(-1)).toBe('dbx ')
    await key('return')
    expect(last().typing).toBe(false)
    expect(text()[0]).toBe('  / dbx')
  })

  test('a choice opens a menu of all and its values; Enter picks one; onChange hears it', async () => {
    const got: unknown[] = []
    const inc = kit.choice({ title: 'incident', all: 'all', key: 'i', values: ['INC-311', 'INC-312'], onChange: (v: unknown) => got.push(v) })
    kit.draw((d: any) => {
      const r = d.row()
      inc.add(r)
      r.end()
    })
    await tick()
    expect(text()[0]).toBe('  incident  all')
    await key('i')
    expect(text()[1]).toMatch(/^ {2}╭─ incident ─+╮$/)
    expect(menu().map((r: string) => r.trim())).toEqual(['❯ all', 'INC-311', 'INC-312'])
    await key('down')
    await key('down')
    await key('return')
    expect(got).toEqual(['INC-312'])
    expect(text()).toEqual(['  incident  INC-312'])
  })

  test('a value\'s indent stands its menu row in, 2 cells a level, for a tree; the row shows its name alone', async () => {
    const scope = kit.choice({ title: 'sessions', all: 'all', key: 's', values: [{ name: 'Run 1 · nested team', value: 'r:r1' }, { name: 'lead', value: 's:a', indent: 1 }, { name: 'survey', value: 's:b', indent: 2 }] })
    kit.draw((d: any) => {
      const r = d.row()
      scope.add(r)
      r.end()
    })
    await tick()
    await key('s')
    expect(menu()).toEqual(['❯ all', '  Run 1 · nested team', '    lead', '      survey'])
    await key('down')
    await key('down')
    await key('down')
    await key('return')
    expect(scope.value).toBe('s:b')
    expect(text()).toEqual(['  sessions  survey'])
  })

  test('a choice with all: false holds its values alone, opens on the first, and Reset puts it back there', async () => {
    const got: unknown[] = []
    const kind = kit.choice({ title: 'items', all: false, key: 'i', values: [{ name: 'pull requests', value: 'pulls' }, { name: 'issues', value: 'issues' }], onChange: (v: unknown) => got.push(v) })
    kit.draw((d: any) => {
      const r = d.row()
      kind.add(r)
      r.end()
    })
    await tick()
    expect(kind.value).toBe('pulls')
    expect(kit.changed()).toBe(false)
    expect(text()[0]).toBe('  items  pull requests')
    await key('i')
    expect(menu().map((r: string) => r.trim())).toEqual(['❯ pull requests', 'issues'])
    await key('down')
    await key('return')
    expect(got).toEqual(['issues'])
    expect(text()).toEqual(['  items  issues'])
    expect(kit.changed()).toBe(true)
    kit.reset()
    await tick()
    expect(kind.value).toBe('pulls')
    expect(got.at(-1)).toBe('pulls')
  })
})

describe('details', () => {
  test('blocks: text as the record holds it, each line cut at the cell edge, code in the code color, at most max rows and then … N more, which a click opens', async () => {
    init({ cols: 40, rows: 20 })
    kit.draw((d: any) => kit.details(d, {
      blocks: [
        { text: 'pytest -q tests/client/test_http.py --tb=short', code: true },
        { text: Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join('\n'), max: 3 },
        { text: 'one\ntwo', max: 1 },
        { text: '  \n' },
      ],
      facts: [['exit', 1]],
    }))
    await tick()
    expect(text()).toEqual(['  pytest -q tests/client/test_http.py --t…', '  line 1', '  line 2', '  line 3', '  … 3 more', '  one', '  two', '  exit 1'])
    expect(last().lines[0].find((s: any) => s.s.startsWith('pytest')).fg).toBe('permission')
    await click('… 3 more')
    expect(text().slice(1, 7)).toEqual(['  line 1', '  line 2', '  line 3', '  line 4', '  line 5', '  line 6'])
  })

  test('a record with a place shows its place and no ask about it, since its file view asks; a click opens it', async () => {
    init({ cols: 60, rows: 4 })
    const place = 'runs/r1/36fe6b9d-6e6d-4582-aef9-c97a0fe8f576/subagents/agent-a1e955cf.jsonl#L20'
    kit.draw((d: any) => kit.details(d, { place, ask: { ref: place, text: 'x' } }))
    await tick()
    expect(text().join('\n')).not.toContain('ask about it')
    expect(text()[0]).toContain('agent-a1e955cf.jsonl line 20')
    await click('agent-a1e955cf')
    expect(sent.filter((m) => m.t === 'act').at(-1)!.act).toEqual({ kind: 'open', ref: place })
  })

  test('a record without a place offers ask about it; facts take the rows they need, none split', async () => {
    init({ cols: 40, rows: 6 })
    kit.draw((d: any) => kit.details(d, { facts: [['service', 'payments'], ['severity', 'critical'], ['id', 'alr-42']], ask: { ref: 'view:t/alr-42', text: 'x' } }))
    await tick()
    expect(text()).toEqual(['  service payments · severity critical', '  id alr-42', '  ask about it'])
    expect(kit.placeIn('alerts/monitor-20260516-0000.jsonl#L2', 24)).toBe('…/monitor…0.jsonl line 2')
  })
})

// A record's text can hold control characters (a tool's colored output, a bell, a NUL, the C1 characters of text
// decoded twice), and thimble-term draws no text that holds one: its Client's tree does not validate and the view is
// not drawn. The kit keeps them out of every string of a frame.
describe('control characters', () => {
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
  // every string a frame hands thimble-term to draw
  const strings = (f: any): string[] => [
    ...f.lines.flatMap((l: any) => l.map((s: any) => s.s)),
    ...f.hits.flatMap((h: any) => [h.tip ?? '', ...(h.tips ?? [])]),
    ...f.hints,
    ...f.sub,
    f.field?.text ?? '',
    f.error ?? '',
  ]

  test('a frame holds none: an escape sequence goes whole, a bell or a NUL goes, a tab is two spaces, a break in a run is a space, and the columns after them keep their places', async () => {
    init({ cols: 60, rows: 8 })
    kit.draw((d: any) => {
      d.line('red \x1b[31mword\x1b[0m bell\x07 end')
      d.row().add(kit.pad('tab\there', 12)).add('|', {}, { on: () => {}, tip: 'tip \x1b[1mbold\x1b[0m\x07' }).end()
      d.row().add(kit.pad('page\u0000name', 12)).add('|').end()
      d.row().add(kit.pad('quoteâ\u0080\u009d', 12)).add('|').end()
      d.line([{ s: 'two\nlines' }, kit.dim(' and\r\nmore')])
      d.key('z', 'to zap \x1b[2Kit', () => {})
      d.sub('facts \x1b]0;a title\x07here')
    })
    await tick()
    const f = last()
    for (const s of strings(f)) expect(s).not.toMatch(CONTROL)
    expect(text(f)).toEqual(['  red word bell end', '  tab  here   |', '  pagename    |', '  quoteâ      |', '  two lines and more'])
    expect(f.hits[0]).toMatchObject({ y: 1, x0: 14, x1: 15, tip: 'tip bold' })
    expect(f.hints).toContain('z to zap it')
    expect(f.sub).toEqual(['facts here'])
    // a field's text, as the view gave it
    kit.draw((d: any) => d.typing({ text: 'typed\x1b[A\x07' }))
    await tick()
    expect(last().field).toEqual({ text: 'typed' })
  })

  test("a record's NUL, bell or escape sequence reaches no frame: in a list's row, in its details, in the error of a draw that throws", async () => {
    init({ cols: 50, rows: 10 })
    const recs = [{ id: 0, text: 'saved\u0000 by\u0007 bot' }, { id: 1, text: 'ok' }]
    const list = kit.list({ key: (e: any) => e.id })
    kit.draw((d: any) => list.draw(d, {
      items: recs,
      row: (e: any, r: any) => r.add(e.text),
      detail: (e: any, dd: any) => kit.details(dd, { blocks: [{ text: `${e.text}\n\x1b[32mline\x1b[0m\ttwo` }], facts: [['by', 'a\u0000b']] }),
      ask: (e: any) => ({ ref: `revisions.jsonl#L${e.id + 1}`, text: e.text }),
    }))
    await tick()
    await key('return')
    for (const s of strings(last())) expect(s).not.toMatch(CONTROL)
    expect(text().slice(0, 4)).toEqual(['❯ saved by bot', '    saved by bot', '    line  two', '    by ab'])
    // asking about it: the side thread's words, which thimble-term's panel draws
    await key('a')
    expect(sent.filter((m) => m.t === 'act').at(-1)!.act).toEqual({ kind: 'ask', ref: 'revisions.jsonl#L1', text: 'saved by bot' })
    kit.draw(() => {
      throw new Error('a byte \x1b[31mhere\u0000')
    })
    await tick()
    for (const s of strings(last())) expect(s).not.toMatch(CONTROL)
    expect(text()).toEqual(['  × the view could not be drawn: a byte here'])
    expect(last().error).toBe('a byte here')
  })
})

describe('as text', () => {
  test('frameText draws a frame plain, or with escape codes for its styles and hues', () => {
    const f = { lines: [[{ s: '  ' }, { s: '●', fg: '#1d7fc0' }, { s: ' fired', d: true }, { s: ' x', bg: 'selectionBg' }]] }
    expect(kit.frameText(f)).toBe('  ● fired x')
    expect(kit.frameText(f, { ansi: true })).toBe('  \x1b[38;2;29;127;192m●\x1b[0m\x1b[2m fired\x1b[0m\x1b[48;5;238m x\x1b[0m')
  })

  test("a diff's added and removed lines take Claude Code's diff colors, green and red as text", () => {
    expect([kit.COLORS.added, kit.COLORS.removed]).toEqual(['diffAddedWord', 'diffRemovedWord'])
    const f = { lines: [[{ s: '▆', fg: kit.COLORS.added }, { s: '▃', fg: kit.COLORS.removed }]] }
    expect(kit.frameText(f, { ansi: true })).toBe('\x1b[32m▆\x1b[0m\x1b[31m▃\x1b[0m')
  })
})
