// The terminal view kit (backend/app/term_kit/kit.mjs), which a view's view.term.js imports to draw the view in
// terminal mode (docs/terminal-views.md): its rows stay inside the frame, a draw that throws is one red line, acts reach
// thimble only during the analyst's own key or click, a fetch is a query that a newer one drops, Color by's top row
// turns a value's hue off while its records stay, and no control character in a record reaches a frame. Each test plays
// the runtime's half (init, events, answers) in this process; the sandboxed process and the view host are
// backend/tests_public/test_term_views.py.
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
    const colour = kit.colorBy({ fields: FIELDS, onChange: () => heard++, initial: 'kind' })
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
