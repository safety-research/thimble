// The terminal view kit's row controls (backend/app/term_kit/kit.mjs, docs/terminal-views.md), drawn as text: Filter
// by's values are toggles in the top row and a value turned off hides its rows; and every choice of the parts the
// program drew is listed for the checks. Each test plays the runtime's half (init, events, answers) in this process, as
// term-kit.test.ts does.
import { beforeEach, describe, expect, test } from 'vitest'

type Msg = { t: string; [k: string]: any }
const KIT_URL = new URL('../../../backend/app/term_kit/kit.mjs', import.meta.url).href
const kit: any = await import(/* @vite-ignore */ KIT_URL)

let sent: Msg[] = []
let n = 0
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const frames = () => sent.filter((m) => m.t === 'frame')
const last = () => frames().at(-1)!
const text = (f = last()) => f.lines.map((l: { s: string }[]) => l.map((s) => s.s).join('').replace(/\s+$/, ''))
const runsAt = (f: any, y: number) => f.lines[y] as { s: string; fg?: string; bg?: string; d?: boolean; b?: boolean }[]
// the run that draws cell x of row y (counted from the frame's left edge, the margin's 2 cells included)
function cell(f: any, y: number, x: number) {
  let at = 0
  for (const r of runsAt(f, y)) {
    const chars = [...r.s]
    if (x < at + chars.length) return { ...r, s: chars[x - at] }
    at += chars.length
  }
  return null
}
const menu = (rows = text()) => rows.filter((r: string) => /^\s*│/.test(r)).map((r: string) => r.replace(/^\s*│ /, '').replace(/\s*│$/, ''))

const T0 = Date.UTC(2026, 4, 16, 9) / 1000
const CALLS = [
  { ref: 'r1/lead.jsonl#L3', t: T0, session: 'lead', tool: 'Task', outcome: 'ok' },
  { ref: 'r1/explore.jsonl#L2', t: T0 + 600, session: 'explore', tool: 'Grep', outcome: 'ok' },
  { ref: 'r1/explore.jsonl#L4', t: T0 + 900, session: 'explore', tool: 'Read', outcome: 'error' },
  { ref: 'r1/grep.jsonl#L2', t: T0 + 1000, session: 'grep', tool: 'Grep', outcome: 'ok' },
  { ref: 'r1/test.jsonl#L2', t: T0 + 2000, session: 'test', tool: 'Bash', outcome: 'denied' },
  { ref: 'r1/lead.jsonl#L9', t: T0 + 3000, session: 'lead', tool: '', outcome: 'ok' },
]
const TACTIC = (values: string[]) => ({ id: 'k1', name: 'Tactic', kind: 'prompt', text: 'What the agent is doing', spec: '', scope: 'r1/*.jsonl', values: values.map((v) => ({ name: v, highlight: true, meaning: '', n: 1 })), here: true, on: true })

function init(o: Record<string, unknown> = {}) {
  kit.__driver.reset()
  sent = []
  n = 0
  kit.__driver.connect((m: Msg) => sent.push(m))
  kit.handle({ t: 'init', cols: 100, rows: 30, view: { slug: 'v', name: 'V' }, labels: [], state: {}, ...o })
}
async function key(k: string) {
  kit.handle({ t: 'key', key: k, n: ++n })
  await tick()
}
async function click(words: string, x = 0, nth = 0) {
  const f = last()
  const rows = text(f)
  const found = f.hits.map((h: any, i: number) => [h, i]).filter(([h]: any) => (rows[h.y] ?? '').slice(h.x0, h.x1).includes(words))
  expect(found.length, `a hot region shows ${words}`).toBeGreaterThan(nth)
  kit.handle({ t: 'click', i: found[nth][1], seq: f.seq, x, n: ++n })
  await tick()
}

beforeEach(() => init())

describe('Filter by', () => {
  test("the top row: Filter by, the choice, its values as toggles, ● while a value shows and ○ while it is off, never a hue; a click hides a value's rows; the reader gets Color by's query", async () => {
    let calls = 0
    const filter = kit.filterBy({ fields: [{ name: 'outcome', title: 'Outcome', values: ['ok', 'error', 'denied'] }, { name: 'tool', title: 'Tool' }], onChange: () => calls++ })
    kit.draw((d: any) => {
      const r = d.row()
      filter.add(r)
      r.end()
      for (const c of CALLS.filter((c) => filter.keeps(c))) d.line(c.ref)
    })
    await tick()
    expect(text()[0]).toBe('  Filter by  none')
    expect(filter.query()).toBe(null)
    // f opens the menu: none, the fields with their values in words, the commonest first; Enter picks one
    await key('f')
    expect(menu().map((r: string) => r.replace(/\s+/g, ' ').trim())).toEqual(['❯ none', 'Outcome ok · error · denied', 'Tool Grep · Task · Read · Bash'])
    await key('down')
    await key('return')
    expect(filter.by).toEqual({ field: 'outcome', title: 'Outcome' })
    expect(text()[0]).toBe('  Filter by  Outcome  ● ok 4  ● error 1  ● denied 1')
    // the toggles carry no hue: the dot is in the text color
    const dot = cell(last(), 0, text()[0].indexOf('● ok'))
    expect(dot && dot.fg).toBeFalsy()
    await click('● error')
    expect(text()[0]).toBe('  Filter by  Outcome  ● ok 4  ○ error 1  ● denied 1')
    expect(text()).not.toContain('  r1/explore.jsonl#L4')
    expect(text().filter((r: string) => r.startsWith('  r1/'))).toHaveLength(5)
    expect(filter.query()).toEqual({ field: 'outcome', off: ['error'] })
    expect(calls).toBeGreaterThan(0)
    // kept per view, and Reset turns the value back on
    expect(kit.__driver.state.kept.filter).toEqual({ by: 'field:outcome', off: { 'field:outcome': ['error'] } })
    expect(kit.changed()).toBe(true)
    kit.reset()
    await tick()
    expect(filter.query()).toEqual({ field: 'outcome', off: [] })
    expect(text().filter((r: string) => r.startsWith('  r1/'))).toHaveLength(6)
  })
})

describe("the checks' choices and the labels the parts turn on", () => {
  test("every choice of the parts the program drew, Color by's first, as the checks ask for them; each made as the analyst's key makes it, its error its own", async () => {
    init({ labels: [TACTIC(['explore', 'test'])] })
    const colour = kit.colorBy({ fields: [{ name: 'tool', title: 'Tool' }, { name: 'outcome', title: 'Outcome' }], onChange: () => void colour.by.title })
    const filter = kit.filterBy({ fields: [{ name: 'outcome', title: 'Outcome' }] })
    const rows = kit.rows({ fields: [{ name: 'session', title: 'Session' }] })
    // a part not drawn yet offers no choice
    expect(kit.__driver.choices()).toEqual([])
    kit.draw((d: any) => {
      colour.draw(d, (r: any) => {
        filter.add(r).gap()
        rows.add(r).gap()
      })
      d.line(`grouped by ${rows.by.title}`)
    })
    await tick()
    kit.handle({ t: 'choices', id: 7 })
    expect(sent.find((m) => m.t === 'choices')).toEqual({
      t: 'choices', id: 7, choices: [['Color by', 'Off'], ['Color by', 'Tool'], ['Color by', 'Outcome'], ['Color by', 'Tactic'], ['Color by', 'Tool + Outcome'],
        ['Filter by', 'None'], ['Filter by', 'Outcome'], ['Filter by', 'Tactic'], ['Rows', 'None'], ['Rows', 'Session'], ['Rows', 'Tactic']],
    })
    const choose = async (control: string, choice: string) => {
      kit.handle({ t: 'choose', control, choice, n: ++n })
      await tick()
    }
    // Rows: None throws as the view draws: that frame says so; the next choice draws again
    await choose('Rows', 'None')
    expect(last().error).toMatch(/reading 'title'/)
    expect(last().ack).toBe(n)
    await choose('Rows', 'Session')
    expect(last().error).toBeUndefined()
    expect(text()).toContain('  grouped by Session')
    // Color by: Off throws as it is chosen (its onChange): the view stays failed until the next choice, which draws
    await choose('Color by', 'Off')
    expect(sent.filter((m) => m.t === 'error').at(-1)!.message).toMatch(/reading 'title'/)
    expect(last().error).toMatch(/reading 'title'/)
    await choose('Color by', 'Tool + Outcome')
    expect(last().error).toBeUndefined()
    expect(colour.picks.map((p: any) => p.title)).toEqual(['Tool', 'Outcome'])
    await choose('Filter by', 'Tactic')
    expect(filter.by).toEqual({ label: 'k1', title: 'Tactic' })
  })
})
