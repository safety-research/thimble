// The terminal view kit's row controls, lanes, side pane, divider and transcript (backend/app/term_kit/kit.mjs,
// docs/terminal-views.md), drawn as text: Filter by's values are toggles in the top row, `●` while a value shows and
// `○` while it is off, never in a hue, and a value turned off hides its rows; Rows groups by a field, a tree of them
// with its guides left-aligned, or a label, each class a lane, a class added to the label a new lane; the lanes draw a
// failure as `×` in red and their key's entries are toggles, Density draws no band, drawLane draws the view's own
// cells (a shaded span `░`, a cell) under the records' marks, and the timeline works alone, on its records' own span of
// times or numbers with its axis under it; a chart's cells are marked under the pointer rather than
// drawn inverse, with a tip per cell; the list's rows in view are on the selection background across the lanes; a row
// opens in a side pane beside the list, or under it in a narrow panel, never under the row; `{` `}` resize the
// overview; a transcript draws its turns as thimble-term's file view does; and the view says it loads while a reader
// query is out. Each test plays the runtime's half (init, events, answers) in this process, as term-kit.test.ts does.
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
const PARENT: Record<string, string | null> = { lead: null, explore: 'lead', grep: 'explore', test: 'lead' }
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
// the marks thimble answers for the label Tactic, as the view host answers {$thimble: 'marks'}
function answerMarks(values: Record<string, string>) {
  for (const q of sent.filter((m) => m.t === 'query' && m.q && m.q.$thimble === 'marks' && !m.answered)) {
    q.answered = true
    const out: Record<string, Record<string, string>> = {}
    for (const r of q.q.refs) out[r] = values[r] ? { k1: values[r] } : {}
    kit.handle({ t: 'answer', id: q.id, data: out })
  }
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

  test("the toggles that do not fit go behind +N, which opens the menu; a value's tip says what it means", async () => {
    const filter = kit.filterBy({ fields: [{ name: 'tool', title: 'Tool', meanings: { Grep: 'searches files' } }], initial: 'tool' })
    kit.draw((d: any) => {
      const r = d.row()
      filter.add(r, { max: 34 })
      r.end()
      for (const c of CALLS) filter.keeps(c)
    })
    await tick()
    await tick()
    expect(text()[0]).toMatch(/^ {2}Filter by {2}Tool {2}● Grep 2 {2}\+4$/)
    const f = last()
    const grep = f.hits.find((h: any) => text(f)[h.y].slice(h.x0, h.x1).includes('Grep'))
    expect(grep.tip).toContain('Grep: searches files')
  })
})

describe('Rows', () => {
  test('a field with parentOf is a tree, each group under its parent with its guide; a label groups by its classes, and a class added to it is a new group', async () => {
    let changes = 0
    init({ labels: [TACTIC(['explore', 'verify'])] })
    const rows = kit.rows({ fields: [{ name: 'session', title: 'Session', parentOf: (k: string) => PARENT[k] }, { name: 'tool', title: 'Tool' }], onChange: () => changes++ })
    kit.draw((d: any) => {
      const r = d.row()
      rows.add(r)
      r.end()
    })
    await tick()
    expect(text()[0]).toBe('  Rows  Session')
    expect(rows.groups(CALLS).map((g: any) => `${g.guide}${g.name}`)).toEqual(['lead', '├ explore', '│ └ grep', '└ test'])
    rows.choose('tool')
    expect(rows.groups(CALLS).map((g: any) => g.name)).toEqual(['Task', 'Grep', 'Read', 'Bash', 'no tool'])
    // by the label: its classes, then the records it does not mark, once thimble answered for them
    rows.choose({ label: 'k1' })
    rows.groups(CALLS)
    await tick()
    answerMarks({ 'r1/lead.jsonl#L3': 'explore', 'r1/test.jsonl#L2': 'verify' })
    await tick()
    expect(rows.groups(CALLS).map((g: any) => [g.name, g.items.length])).toEqual([['explore', 1], ['verify', 1], ['not marked', 4]])
    // the query names the label, so the reader reads it though it is not on in Files
    expect(sent.filter((m) => m.t === 'query').at(-1)!.labels).toEqual(['k1'])
    // the label gains a class: a new group, and the page hears it
    const was = changes
    kit.handle({ t: 'labels', labels: [TACTIC(['explore', 'verify', 'plan'])], filter: null })
    await tick()
    expect(changes).toBeGreaterThan(was)
    expect(rows.groups(CALLS).map((g: any) => g.name).slice(0, 3)).toEqual(['explore', 'verify', 'plan'])
    expect(kit.__driver.state.kept.rows).toEqual({ by: 'label:k1' })
  })

  test("it opens on a label named in `initial` while the label is on, else the field after it; Color by does not take the label it groups by", async () => {
    init({ labels: [TACTIC(['explore', 'verify'])] })
    const colour = kit.colorBy({ fields: [{ name: 'tool', title: 'Tool' }], initial: 'tool' })
    const rows = kit.rows({ fields: [{ name: 'session', title: 'Session' }, { name: 'tool', title: 'Tool' }], initial: [{ label: 'tactic' }, 'tool'] })
    kit.draw((d: any) => {
      const r = d.row()
      rows.add(r)
      r.end()
      colour.draw(d)
    })
    await tick()
    // found by its name, the case aside; the label opened Color by too until Rows held it
    expect(rows.by).toEqual({ label: 'k1', title: 'Tactic' })
    expect(text()[0]).toBe('  Rows  Tactic ↗')
    expect(colour.by).toEqual({ field: 'tool', title: 'Tool' })
    // nothing was chosen, so nothing of Rows is kept
    expect(kit.__driver.state.kept.rows).toBe(undefined)
    // turned off, the label gives way to the field after it; on again, it is Rows' again and still not the colour
    kit.handle({ t: 'labels', labels: [{ ...TACTIC(['explore', 'verify']), on: false }], filter: null })
    await tick()
    expect(rows.by).toEqual({ field: 'tool', title: 'Tool' })
    kit.handle({ t: 'labels', labels: [TACTIC(['explore', 'verify'])], filter: null })
    await tick()
    expect(rows.by).toEqual({ label: 'k1', title: 'Tactic' })
    expect(colour.by).toEqual({ field: 'tool', title: 'Tool' })
    // a label no part holds still takes the colour when it is turned on
    kit.handle({ t: 'labels', labels: [TACTIC(['explore', 'verify']), { ...TACTIC(['early']), id: 'k2', name: 'Phase' }], filter: null })
    await tick()
    expect(colour.by).toEqual({ label: 'k2', title: 'Phase' })
    // a choice in the menu is kept, and the label no longer moves it
    rows.choose('session')
    expect(kit.__driver.state.kept.rows).toEqual({ by: 'field:session' })
    kit.handle({ t: 'labels', labels: [TACTIC(['explore', 'verify'])], filter: null })
    await tick()
    expect(rows.by).toEqual({ field: 'session', title: 'Session' })
  })

  test('a record the reader gave its group keeps it', () => {
    const rows = kit.rows({ fields: [{ name: 'tool', title: 'Tool' }] })
    expect(rows.groups([{ ref: 'a#L1', tool: 'Bash', group: 'Edit' }]).map((g: any) => g.name)).toEqual(['Edit'])
  })
})

describe('lanes', () => {
  function scene(o: { rows?: number; span?: any; room?: number; density?: boolean } = {}) {
    init({ rows: o.rows ?? 30 })
    const colour = kit.colorBy({ fields: [{ name: 'tool', title: 'Tool' }] })
    const rows = kit.rows({ fields: [{ name: 'session', title: 'Session', parentOf: (k: string) => (k === 'lead' ? 'run' : k === 'run' ? null : PARENT[k]), nameOf: (k: string) => (k === 'run' ? 'Run 1' : k) }] })
    const range = kit.timeRange({})
    range.data({ times: CALLS.map((c) => c.t), values: (i: number) => colour.valueOf(CALLS[i]) })
    const picked: string[] = []
    const marked: string[] = []
    const lanes = kit.lanes({ rows, colour, problem: (c: any) => c.outcome !== 'ok', band: (l: any) => (l.items.length ? [[l.items[0].t, l.items.at(-1).t]] : []), onPick: (l: any) => picked.push(l.key), onMark: (c: any) => marked.push(c.ref) })
    kit.draw((d: any) => {
      range.draw(d, { gutter: 16 })
      const scale = range.scale(d.cols - 16)
      lanes.draw(d, { items: CALLS, scale, gutter: 16, room: o.room, span: o.span, density: o.density })
      kit.axis(d, scale, { gutter: 16, legend: lanes.legend() })
    })
    return { lanes, picked, marked }
  }

  test('a lane per group: the top group with its ▾, the others with their guides at A2, left-aligned; a failure × in red; the key\'s entries are toggles', async () => {
    const { lanes, picked } = scene({ density: false })
    await tick()
    const rows = text()
    const names = rows.slice(2, 7).map((r: string) => r.slice(0, 16).trimEnd())
    expect(names).toEqual(['  ▾ Run 1', '    └ lead', '      ├ explore', '      │ └ grep', '      └ test'])
    // explore's failed read, a × in red where most of its cell failed
    const f = last()
    const explore = rows.findIndex((r: string) => r.includes('├ explore'))
    const x = [...rows[explore]].indexOf('×')
    expect(x).toBeGreaterThan(16)
    expect(cell(f, explore, x)!.fg).toBe(kit.COLORS.problem)
    // the key: running and failed, each a toggle; failed hidden takes the × away
    expect(rows.some((r: string) => r.includes('─ running') && r.includes('× failed'))).toBe(true)
    await click('× failed')
    expect(lanes.isOn('problem')).toBe(false)
    expect(text()[explore]).not.toContain('×')
    expect(kit.changed()).toBe(true)
    // a click on a lane's name chooses it, in the accent
    await click('grep')
    expect(picked).toEqual(['grep'])
    expect(lanes.chosen).toBe('grep')
  })

  test("a lane's cells are a chart's: the hit marks its cell under the pointer (cursor), with each cell's time and records in its tip; a click opens the nearest record", async () => {
    const { marked } = scene()
    await tick()
    const f = last()
    const rows = text(f)
    const lead = rows.findIndex((r: string) => r.includes('└ lead'))
    const hit = f.hits.find((h: any) => h.y === lead && h.cursor)
    expect(hit).toBeTruthy()
    expect(hit.x0).toBe(2 + 16)
    expect(hit.tips).toHaveLength(100 - 16)
    expect(hit.tips[0]).toMatch(/^lead · May 16 09:00:\d\d · 1 record$/)
    // the time range's strip is a chart too, with its own tips
    const strip = f.hits.find((h: any) => h.y === 1 && h.cursor)
    expect(strip && strip.tips[0]).toMatch(/May 16 09:00.* · 1 record/)
    kit.handle({ t: 'click', i: f.hits.indexOf(hit), seq: f.seq, x: 0, n: ++n })
    await tick()
    expect(marked).toEqual(['r1/lead.jsonl#L3'])
  })

  test("the list's rows in view are on the selection background across the lanes", async () => {
    scene({ span: [T0 + 500, T0 + 1100] })
    await tick()
    const f = last()
    const rows = text(f)
    const explore = rows.findIndex((r: string) => r.includes('├ explore'))
    const bgs = runsAt(f, explore).filter((r) => r.bg === kit.COLORS.selected).map((r) => r.s).join('')
    expect(bgs.length).toBeGreaterThan(5)
    expect(runsAt(f, explore).slice(0, 2).some((r) => r.bg)).toBe(false)
  })

  test('Density draws its bars alone: no band `─` where a lane ran, and no `running` in the key; Events draws the band', async () => {
    scene()
    await tick()
    const lane = (rows: string[], name: string) => rows.find((r: string) => r.includes(name))!.slice(18)
    // explore ran from its first call to its last: in Density only its bars, no ─ between them
    expect(lane(text(), '├ explore')).toMatch(/[▁▂▃▄▅▆▇█×]/)
    expect(lane(text(), '├ explore')).not.toContain('─')
    expect(text().some((r: string) => r.includes('─ running'))).toBe(false)
    expect(text().some((r: string) => r.includes('× failed'))).toBe(true)
    init()
    scene({ density: false })
    await tick()
    expect(lane(text(), '├ explore')).toContain('─')
    expect(text().some((r: string) => r.includes('─ running'))).toBe(true)
  })

  test("drawLane draws the view's own cells under the records' marks: a shaded span ░ named in its cells' tips, its series a key entry that hides it; marks: false leaves the records' cells to the view, and a click still opens the nearest record", async () => {
    init()
    const colour = kit.colorBy({ fields: [{ name: 'tool', title: 'Tool' }] })
    const rows = kit.rows({ fields: [{ name: 'session', title: 'Session' }] })
    const range = kit.timeRange({})
    range.data({ times: CALLS.map((c) => c.t) })
    const marked: string[] = []
    const seen: any[] = []
    let marks: any = undefined
    let ln: any
    kit.draw((d: any) => {
      const scale = range.scale(d.cols - 16)
      ln = kit.timeline({
        key: 'own', rows, colour, marks, onMark: (c: any) => marked.push(c.ref),
        series: [{ id: 'freeze', name: 'freeze', mark: 'band' }],
        drawLane: (lane: any, ctx: any) => {
          seen.push({ key: lane.key, cols: ctx.cols, hue: lane.items.length ? ctx.colorOf(lane.items[0]) : null })
          if (lane.key === 'explore') ctx.shade(T0 + 300, T0 + 1500, { name: 'deploy freeze', series: 'freeze' })
          if (lane.key === 'lead') for (const it of lane.items) ctx.put(ctx.x(it.t), { s: '◆', fg: '#123456' })
        },
      })
      ln.draw(d, { items: CALLS, scale, gutter: 16, density: false })
      kit.axis(d, scale, { gutter: 16, legend: ln.legend() })
    })
    colour.counts({ Grep: 2, Task: 1, Read: 1, Bash: 1 })
    await tick()
    const y = (name: string) => text().findIndex((r: string) => r.trimStart().startsWith(name))
    // the span's cells ░ in the rule gray, the records' marks ▌ over them; its name in the tips of its cells alone
    const explore = text()[y('explore')]
    expect(explore).toContain('░')
    expect(explore.replace(/[^▌]/g, '')).toBe('▌▌')
    const x = [...explore].indexOf('░')
    expect(cell(last(), y('explore'), x)!.fg).toBe(kit.COLORS.rule)
    const hit = last().hits.find((h: any) => h.y === y('explore') && h.cursor)
    expect(hit.tips[x - hit.x0]).toMatch(/ · deploy freeze$/)
    expect(hit.tips[0]).not.toContain('deploy freeze')
    // drawLane hears each lane with the lane's cells, and the Color by hue of a record
    expect(seen.slice(-4).map((s) => s.key)).toEqual(['lead', 'explore', 'grep', 'test'])
    expect(seen[0].cols).toBe(100 - 16)
    const hue = seen.filter((s) => s.key === 'grep').at(-1).hue
    expect(hue).toBe(colour.colourOf('Grep'))
    expect(hue).not.toBe(kit.COLORS.dim)
    // the series' key entry hides it; Reset shows it again
    expect(text().some((r: string) => r.includes('░ freeze'))).toBe(true)
    await click('░ freeze')
    expect(ln.isOn('freeze')).toBe(false)
    expect(text()[y('explore')]).not.toContain('░')
    expect(text().some((r: string) => r.includes('░ freeze'))).toBe(true)
    // the lead's own ◆ stand under its ▌ marks; with marks: false the ◆ show, and a click still opens the nearest record
    expect(text()[y('lead')]).not.toContain('◆')
    marks = false
    kit.redraw()
    await tick()
    const lead = text()[y('lead')]
    expect(lead).not.toContain('▌')
    expect(lead.replace(/[^◆]/g, '')).toBe('◆◆')
    const lx = [...lead].indexOf('◆')
    expect(cell(last(), y('lead'), lx)!.fg).toBe('#123456')
    const leadHit = last().hits.find((h: any) => h.y === y('lead') && h.cursor)
    kit.handle({ t: 'click', i: last().hits.indexOf(leadHit), seq: last().seq, x: lx - leadHit.x0, n: ++n })
    await tick()
    expect(marked).toEqual(['r1/lead.jsonl#L3'])
  })

  test('Events draws a mark ▌ in each cell that holds a record, in place of the bars of its records', async () => {
    init()
    const colour = kit.colorBy({ fields: [{ name: 'tool', title: 'Tool' }] })
    const rows = kit.rows({ fields: [{ name: 'session', title: 'Session' }] })
    const range = kit.timeRange({})
    range.data({ times: CALLS.map((c) => c.t) })
    const ln = kit.lanes({ rows, colour })
    let dense = true
    kit.draw((d: any) => {
      const scale = range.scale(d.cols - 16)
      ln.draw(d, { items: CALLS, scale, gutter: 16, density: dense })
    })
    await tick()
    const lane = (name: string) => text().find((r: string) => r.trimStart().startsWith(name))!.slice(18)
    expect(lane('explore')).toMatch(/[▁▂▃▄▅▆▇█]/)
    expect(lane('explore')).not.toContain('▌')
    dense = false
    kit.redraw()
    await tick()
    expect(lane('explore').replace(/ /g, '')).toBe('▌▌')
    expect(lane('lead').replace(/ /g, '')).toBe('▌▌')
  })

  test('a value turned off in Color by keeps its records in the lanes and the time range\'s strip, dim, with no hue', async () => {
    init()
    const colour = kit.colorBy({ fields: [{ name: 'tool', title: 'Tool' }] })
    const rows = kit.rows({ fields: [{ name: 'session', title: 'Session' }] })
    const range = kit.timeRange({})
    range.data({ times: CALLS.map((c) => c.t), values: (i: number) => colour.valueOf(CALLS[i]) })
    const ln = kit.lanes({ rows, colour })
    kit.draw((d: any) => {
      range.draw(d, { gutter: 16 })
      const scale = range.scale(d.cols - 16)
      ln.draw(d, { items: CALLS, scale, gutter: 16, density: false })
    })
    colour.counts({ Grep: 2, Task: 1, Read: 1, Bash: 1 })
    await tick()
    const grep = colour.colourOf('Grep')
    expect(grep).toBeTruthy()
    // the grep lane's one record, and the strip's cells (row 1) of the two Grep calls, in Grep's hue
    const markOf = () => {
      const f = last()
      const y = text(f).findIndex((r: string) => r.trimStart().startsWith('grep'))
      return cell(f, y, [...text(f)[y]].indexOf('▌', 18))!
    }
    const stripCells = () => runsAt(last(), 1).flatMap((r) => [...r.s].map((ch) => ({ ch, fg: r.fg, d: r.d }))).filter((c) => c.ch.trim())
    expect(markOf().fg).toBe(grep)
    const glyphs = stripCells().length
    expect(stripCells().filter((c) => c.fg === grep)).toHaveLength(2)
    colour.toggle('Grep')
    await tick()
    expect(colour.isOn('Grep')).toBe(false)
    // its records stay, drawn dim: the lane's mark, and every glyph of the strip
    expect(markOf().s).toBe('▌')
    expect(markOf().fg).toBeUndefined()
    expect(markOf().d).toBe(true)
    expect(stripCells()).toHaveLength(glyphs)
    expect(stripCells().filter((c) => c.fg === grep)).toHaveLength(0)
  })

  test('the lanes past their room fold a top group, and past that wait behind … N more', async () => {
    scene({ room: 2 })
    await tick()
    const rows = text()
    expect(rows[2].slice(0, 16).trim()).toBe('▸ Run 1')
    expect(rows.slice(2, 4).some((r: string) => r.includes('lead'))).toBe(false)
  })
})

describe('the timeline on its own', () => {
  test("with no scale it lays out its records' own span and draws its axis under the lanes; lanes from a field's name, one for the records with none; a record with no place left out; `lanes` is the same call", async () => {
    init({ cols: 80 })
    expect(kit.lanes).toBe(kit.timeline)
    const commits = [
      { t: '2026-05-16T09:00:00Z', author: 'ana', ok: true },
      { t: T0 + 600, author: 'bo', ok: true },
      { t: T0 + 900, author: 'ana', ok: false },
      { t: new Date((T0 + 3000) * 1000), ok: true },
      { t: 'soon', author: 'bo', ok: true },
    ]
    const tl = kit.timeline({ rows: 'author', problem: (c: any) => c.ok === false })
    kit.draw((d: any) => tl.draw(d, { items: commits }))
    await tick()
    const rows = text()
    expect(rows.slice(0, 3).map((r: string) => r.slice(0, 14).trim())).toEqual(['ana', 'bo', 'no author'])
    expect(tl.lanes.map((l: any) => l.items.length)).toEqual([2, 1, 1])
    // the first record in the first cell, the last in the last, failed × in red; the axis under them with its key
    expect([...rows[0]][2 + 14]).toMatch(/[▁▂▃▄▅▆▇█]/)
    expect(rows[2].length).toBe(2 + 80)
    expect(rows[0]).toContain('×')
    expect(rows[3]).toMatch(/^ {2}× failed +May 16 09:00 +09:15/)
    const hit = last().hits.find((h: any) => h.cursor)
    expect(hit.tips[0]).toMatch(/^ana · May 16 09:00:\d\d · 1 record$/)
  })

  test("on plain numbers (unit 'n'): the axis and the tips in numbers; with no rows, one lane with no name, its tips the place alone", async () => {
    init({ cols: 60 })
    const steps = [{ turn: 1 }, { turn: '12' }, { turn: 30 }, { turn: '2026-05-16' }]
    const tl = kit.timeline({ unit: 'n', time: (s: any) => s.turn })
    kit.draw((d: any) => tl.draw(d, { items: steps }))
    await tick()
    const rows = text()
    // the one lane from the panel's edge, no name before it; the date is no turn
    expect(tl.lanes[0].items).toHaveLength(3)
    expect(rows[0].slice(2)).toMatch(/^[▁▂▃▄▅▆▇█]/)
    expect(rows[1].trim().split(/\s+/).every((l: string) => /^\d+$/.test(l))).toBe(true)
    const hit = last().hits.find((h: any) => h.cursor)
    expect(hit.tips[0]).toBe('1 · 1 record')
    expect(hit.tip).toBe('a click opens the record nearest there')
  })

  test("a date given as text with no zone is read in UTC on a machine in any zone, as the browser kit reads it; text with no date in it is no place", async () => {
    const zone = process.env.TZ
    // a machine seven hours behind UTC in May, where Date.parse reads a date with no zone in its own
    process.env.TZ = 'America/Los_Angeles'
    try {
      init({ cols: 80 })
      const commits = [
        { t: '2026-05-16T09:00:00', author: 'ana' },
        { t: '2026-05-16 09:05:00', author: 'ana' },
        { t: 'Sat, 16 May 2026 09:10:00', author: 'bo' },
        { t: '2026/05/16 09:15:00', author: 'bo' },
        { t: 'Sat, 16 May 2026 02:20:00 -0700', author: 'cy' },
        { t: 'step 4', author: 'cy' },
      ]
      const tl = kit.timeline({ rows: 'author' })
      kit.draw((d: any) => tl.draw(d, { items: commits }))
      await tick()
      expect(tl.lanes.map((l: any) => [l.name, l.items.length])).toEqual([['ana', 2], ['bo', 2], ['cy', 1]])
      // the axis from the first record, 09:00 in UTC, to the last, 09:20, the records five minutes apart in their cells
      expect(text()[3]).toMatch(/^ +May 16 09:00 +09:05 +09:10 +09:15$/)
      const marks = (row: string) => [...row].map((ch, i) => (ch === ' ' ? -1 : i)).filter((i) => i >= 16)
      const at = [...marks(text()[0]), ...marks(text()[1]), ...marks(text()[2])]
      expect(at[0]).toBe(16)
      expect(at.at(-1)).toBe(2 + 80 - 1)
      expect(at.slice(1).map((x, i) => x - at[i]).every((g) => Math.abs(g - 16) <= 1)).toBe(true)
      expect(last().hits.find((h: any) => h.cursor).tips[0]).toMatch(/^ana · May 16 09:00:\d\d · 1 record$/)
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  test('on plain numbers such as years or identifiers: the axis, the tips and the time range write them as they are, without separators; a length keeps them', async () => {
    init({ cols: 80 })
    const releases = [2019, 2020, 2021, 2023, 2026].map((year) => ({ year }))
    const tl = kit.timeline({ unit: 'n', time: (r: any) => r.year })
    kit.draw((d: any) => tl.draw(d, { items: releases }))
    await tick()
    const ticks = text()[1].trim().split(/\s+/)
    expect(ticks).toContain('2020')
    expect(ticks.every((l: string) => /^\d{4}$/.test(l))).toBe(true)
    expect(last().hits.find((h: any) => h.cursor).tips[0]).toBe('2019 · 1 record')
    const range = kit.timeRange({ unit: 'n' })
    range.data({ times: [67000, 69500] })
    expect(range.readout()).toBe('67000 – 69500 · 2,500')
    expect(range.format(68012)).toBe('68012')
  })

  test("under the time range's scale of numbers, its unit: a time is no place there", async () => {
    init()
    const range = kit.timeRange({ unit: 'n' })
    range.data({ times: [0, 10, 40] })
    const tl = kit.timeline({ rows: (s: any) => s.agent, time: (s: any) => s.turn })
    kit.draw((d: any) => tl.draw(d, { items: [{ turn: 0, agent: 'lead' }, { turn: 10, agent: 'sub' }, { turn: 40, agent: 'lead' }, { turn: '2026-05-16T09:00:00Z', agent: 'sub' }], scale: range.scale(d.cols - 14), gutter: 14 }))
    await tick()
    expect(tl.lanes.map((l: any) => l.items.length)).toEqual([2, 1])
    const hit = last().hits.find((h: any) => h.cursor)
    expect(hit.tips[0]).toBe('lead · 0 · 1 record')
  })

  test('on plain numbers not all whole, such as scores: the ticks and the tips in decimals, each tick once; whole numbers never step under one; no records, no axis', async () => {
    init({ cols: 80 })
    const runs = [0.05, 0.31, 0.5, 0.72, 0.95].map((score) => ({ score }))
    const tl = kit.timeline({ unit: 'n', time: (r: any) => r.score })
    kit.draw((d: any) => tl.draw(d, { items: runs }))
    await tick()
    const ticks = text()[1].trim().split(/\s+/)
    expect(ticks).toEqual(expect.arrayContaining(['0.2', '0.4']))
    expect(new Set(ticks).size).toBe(ticks.length)
    // the first cell's middle, to the hundredth a cell spans
    expect(last().hits.find((h: any) => h.cursor).tips[0]).toMatch(/^0\.0\d · 1 record$/)
    // turns 0 to 3: a tick at each whole turn, never 0.5
    const turns = kit.timeline({ unit: 'n', time: (r: any) => r.turn })
    kit.draw((d: any) => turns.draw(d, { items: [0, 1, 2, 3].map((turn) => ({ turn })) }))
    await tick()
    expect(text()[1].trim().split(/\s+/)).toEqual(['0', '1', '2', '3'])
    // nothing to place: no axis of 1970 under no lanes
    const none = kit.timeline({ rows: 'author' })
    kit.draw((d: any) => none.draw(d, { items: [] }))
    await tick()
    expect(text().filter(Boolean)).toEqual([])
  })
})

describe('a page\'s own chart', () => {
  test('a hit over cells that hold only a chart\'s glyphs is marked by its cell under the pointer, never drawn inverse; a word control is not', async () => {
    kit.draw((d: any) => {
      d.row().add('▁▃█ ▃▁─×', {}, { on: () => {}, tip: 'a lane' }).end()
      d.row().add('choose', {}, { on: () => {} }).end()
    })
    await tick()
    const [lane, word] = last().hits
    expect(lane.cursor).toBe(true)
    expect(word.cursor).toBeUndefined()
  })
})

describe('the side pane', () => {
  function scene(cols: number, rows = 24) {
    init({ cols, rows })
    const side = kit.side({})
    const list = kit.list({ key: (c: any) => c.ref })
    const opened: string[] = []
    kit.draw((d: any) => {
      list.draw(d, {
        items: CALLS,
        side,
        row: (c: any, r: any) => r.add(`${c.tool || 'text'}  ${c.ref}`),
        onOpen: (c: any) => opened.push(c.ref),
        detail: (c: any, dd: any) => kit.details(dd, { text: `the whole record of ${c.ref}`, place: c.ref }),
      })
    })
    return { side, list, opened }
  }

  test('Enter opens the chosen row beside the list, a │ between them, never under its row; Backspace closes it; < > resize it, kept per view', async () => {
    const { side, opened } = scene(120)
    await tick()
    await key('down')
    await key('return')
    expect(side.isOpen).toBe(true)
    expect(opened).toEqual(['r1/explore.jsonl#L2'])
    const rows = text()
    expect(rows[0]).toMatch(/Task {2}r1\/lead\.jsonl#L3 +│ r1\/explore\.jsonl line 2 +close$/)
    expect(rows[1]).toMatch(/^❯ Grep {2}r1\/explore\.jsonl#L2 +│ the whole record of r1\/explore\.jsonl#L2$/)
    // the list keeps every row in place: the details are not under the row
    expect(rows[2]).toMatch(/^ {2}Read {2}r1\/explore\.jsonl#L4/)
    const bar = rows[0].indexOf('│')
    await key('<')
    expect(text()[0].indexOf('│')).toBeLessThan(bar)
    expect(kit.__driver.state.kept.side).toEqual({ side: 0.47 })
    // the pane shows `close`, so the hint row leaves its keys to ?, which lists them
    expect(last().hints).toEqual(['↑↓ to choose', 'Enter to close', '? for all keys'])
    expect(last().keys).toEqual(expect.arrayContaining(['<', '>', 'backspace']))
    await key('?')
    expect(text().some((r: string) => /│\s+< >\s+to resize the details\s+│/.test(r))).toBe(true)
    expect(text().some((r: string) => /│\s+Backspace\s+to close the details\s+│/.test(r))).toBe(true)
    await key('backspace')
    expect(side.isOpen).toBe(false)
    expect(text()[1]).toBe('❯ Grep  r1/explore.jsonl#L2')
  })

  test('in a narrow panel the pane stands under the list, a rule between them', async () => {
    scene(60)
    await tick()
    await key('return')
    const rows = text()
    const rule = rows.findIndex((r: string) => /^ {2}─+$/.test(r))
    expect(rule).toBeGreaterThan(2)
    expect(rows[rule + 1]).toMatch(/r1\/lead\.jsonl line 3 +close$/)
    expect(rows[rule + 2]).toBe('  the whole record of r1/lead.jsonl#L3')
  })
})

describe('the divider', () => {
  test('the overview has the rows the view gives it, at least min on each side; it binds no key, and a share kept before is not read', async () => {
    init({ rows: 20, state: { divider: { overview: 0.2 } } })
    const div = kit.divider({})
    let got = 0
    let want = 10
    kit.draw((d: any) => {
      got = div.rows(d, want)
      for (let i = 0; i < got; i++) d.line(`lane ${i}`)
    })
    await tick()
    expect(got).toBe(10)
    expect(last().keys).toEqual([])
    for (const k of ['{', '}']) await key(k)
    expect(got).toBe(10)
    want = 30
    kit.redraw()
    await tick()
    expect(got).toBe(17)
  })
})

describe('the transcript', () => {
  const TURNS = [
    { ref: 's.jsonl#L1', t: T0, speaker: 'user', kind: 'prompt', text: 'Find the failing test and say why it fails, then propose the smallest fix you can find in the code base.' },
    { ref: 's.jsonl#L2', t: T0 + 5, speaker: 'lead', kind: 'tool', tool: 'Bash', input: 'pytest -q', output: 'FAILED test_a\n1 failed', error: true },
    { ref: 's.jsonl#L4', t: T0 + 86400, speaker: 'lead', kind: 'text', text: 'One test fails.' },
  ]
  test("as thimble-term's file view draws a transcript: the clock dim, ● and the speaker bold, the words under the name, a tool call one dim ⎿ row (a failed one with × and its tool in red), the day on a dim row where it changes", async () => {
    init({ cols: 70 })
    const tr = kit.transcript({})
    kit.draw((d: any) => tr.draw(d, { turns: TURNS, title: 'lead · Run 1' }))
    await tick()
    const f = last()
    expect(text(f)).toEqual([
      '  lead · Run 1  3 turns',
      '  May 16, 2026',
      '❯ 09:00:00  ● user',
      '              Find the failing test and say why it fails, then',
      '              propose the smallest fix you can find in the code base.',
      '  09:00:05  ⎿ × Bash pytest -q',
      '  May 17, 2026',
      '  09:00:00  ● lead',
      '              One test fails.',
    ])
    expect(runsAt(f, 1).find((r) => r.s.includes('May 16'))!.d).toBe(true)
    expect(runsAt(f, 2).find((r) => r.s.includes('user'))!.b).toBe(true)
    expect(runsAt(f, 5).find((r) => r.s.includes('⎿'))!.d).toBe(true)
    // the failed call: × and its tool in the problem red, as the lanes draw it; its input dim
    expect(runsAt(f, 5).find((r) => r.s.includes('× Bash'))!.fg).toBe(kit.COLORS.problem)
    expect(runsAt(f, 5).find((r) => r.s.includes('pytest'))!.d).toBe(true)
    // Enter on the tool call opens it in place: what it ran in the code color, what came back in red
    await key('down')
    await key('return')
    const rows = text()
    const at = rows.findIndex((r: string) => r.includes('FAILED test_a'))
    expect(at).toBeGreaterThan(5)
    expect(runsAt(last(), at).find((r) => r.s.includes('FAILED'))!.fg).toBe(kit.COLORS.problem)
    expect(runsAt(last(), at - 1).find((r) => r.s.includes('pytest'))!.fg).toBe(kit.COLORS.code)
  })

  test("a turn's time given as text is read as the browser's transcript reads it: an ISO time, a mail's date, one with no zone in UTC on a machine in any zone, `time` when it has no `t`; text with no date in it has no clock", async () => {
    const zone = process.env.TZ
    // a machine seven hours behind UTC in May, where Date.parse reads a date with no zone in its own
    process.env.TZ = 'America/Los_Angeles'
    try {
      init({ cols: 70 })
      const at = (i: number, t: unknown, key = 't') => ({ ref: `s.jsonl#L${i}`, [key]: t, speaker: 'lead', kind: 'text', text: `turn ${i}` })
      const turns = [
        at(1, '2026-05-16T09:00:01Z'),
        at(2, '2026-05-16T09:00:02'),
        at(3, '2026-05-16 09:00:03'),
        at(4, 'Sat, 16 May 2026 09:00:04'),
        at(5, '2026-05-16T11:00:05+02:00'),
        at(6, String(T0 + 6)),
        at(7, '2026-05-17T09:00:07', 'time'),
        at(8, 'step 4'),
      ]
      const tr = kit.transcript({})
      kit.draw((d: any) => tr.draw(d, { turns }))
      await tick()
      const rows = text().filter((r: string) => r.includes('●'))
      expect(rows.map((r: string) => r.slice(2, 10))).toEqual(['09:00:01', '09:00:02', '09:00:03', '09:00:04', '09:00:05', '09:00:06', '09:00:07', '        '])
      expect(text().filter((r: string) => /^ {2}May 1[67], 2026$/.test(r))).toEqual(['  May 16, 2026', '  May 17, 2026'])
      // the turns in view give the lanes above the list their times in seconds, read the same way (`span`), a Date too
      expect(tr.list.span()).toEqual([T0 + 1, T0 + 86400 + 7])
      expect(tr.list.span((it: any) => (it.ref === 's.jsonl#L3' ? new Date((T0 + 3) * 1000) : null))).toEqual([T0 + 3, T0 + 3])
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  test("with two choices of Color by a turn's `●` is two, the second in its value's hue of the second choice, a space where it has none", async () => {
    init({ cols: 70, state: { colour: { by: 'field:speaker', picks: ['field:speaker', 'field:mood'], off: [], seen: [] } } })
    const colour = kit.colorBy({ fields: [{ name: 'speaker', title: 'Speaker' }, { name: 'mood', title: 'Mood' }] })
    const tr = kit.transcript({})
    const turns = [{ ...TURNS[0], mood: 'calm' }, TURNS[1], TURNS[2]]
    kit.draw((d: any) => tr.draw(d, { turns, colour }))
    colour.counts({ user: 1, lead: 2 })
    await tick()
    const rows = text()
    expect(rows.find((r: string) => r.includes('user'))).toBe('❯ 09:00:00  ●● user')
    expect(rows.find((r: string) => r.includes('lead') && !r.includes('⎿'))).toBe('  09:00:00  ●  lead')
    const y = rows.findIndex((r: string) => r.includes('user'))
    const mood = colour.tracks[0]
    expect(kit.SERIES).toContain(colour.colourOf('user'))
    expect(cell(last(), y, 12)!.fg).toBe(colour.colourOf('user'))
    expect(cell(last(), y, 13)!.fg).toBe(mood.colourOf('calm'))
    expect(kit.SERIES).toContain(mood.colourOf('calm'))
    expect(mood.colourOf('calm')).not.toBe(colour.colourOf('user'))
  })
})

describe('loading', () => {
  test('a reader query out says the view loads: at once before any answer, after a moment later on; a kit query never does', async () => {
    let rows: string[] = []
    const go = () =>
      kit.fetch({ op: 'rows' }).then((d: any) => {
        rows = d.rows
      })
    kit.draw((d: any) => {
      if (kit.loading()) d.line('◌ loading')
      for (const r of rows) d.line(r)
    })
    go()
    await tick()
    expect(kit.loading()).toBe(true)
    expect(last().loading).toBe(true)
    expect(text()).toEqual(['  ◌ loading'])
    const q = sent.filter((m) => m.t === 'query').at(-1)!
    kit.handle({ t: 'answer', id: q.id, data: { rows: ['a'] } })
    await tick()
    expect(kit.loading()).toBe(false)
    expect(last().loading).toBeUndefined()
    // a later query: quiet for a moment, then loading
    go()
    await tick()
    expect(kit.loading()).toBe(false)
    await tick(180)
    expect(kit.loading()).toBe(true)
    expect(last().loading).toBe(true)
    // the kit's own query (a label's marks) is never the view loading
    const q2 = sent.filter((m) => m.t === 'query').at(-1)!
    kit.handle({ t: 'answer', id: q2.id, data: { rows: ['b'] } })
    kit.fetch({ $thimble: 'marks', refs: ['a#L1'] })
    await tick(180)
    expect(kit.loading()).toBe(false)
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

  test('a label checked in Color by is turned on in Files during the analyst\'s key and keeps its place as a track; unchecked, it is turned off unless Filter by reads it; one Filter by chooses is turned on and Color by keeps its choice', async () => {
    const OFF = { ...TACTIC(['explore']), on: false }
    init({ labels: [OFF] })
    const colour = kit.colorBy({ fields: [{ name: 'tool', title: 'Tool' }] })
    const filter = kit.filterBy({ fields: [{ name: 'outcome', title: 'Outcome' }] })
    kit.draw((d: any) => colour.draw(d, (r: any) => filter.add(r).gap()))
    await tick()
    const shown = () => sent.filter((m) => m.t === 'act' && m.act.kind === 'show').map((m) => m.act)
    // chosen by the page itself, outside the analyst's key, a label is not turned on
    colour.choose({ label: 'k1' })
    filter.choose({ label: 'k1' })
    expect(shown()).toEqual([])
    colour.choose('tool')
    filter.choose(null)
    // Space on it in the menu checks it, a track after Tool, and turns it on
    await key('c')
    await key('down')
    await key('space')
    expect(colour.picks.map((p: any) => p.title)).toEqual(['Tool', 'Tactic'])
    expect(shown()).toEqual([{ kind: 'show', id: 'k1', on: 'on' }])
    // thimble says it is on: it stays a track, as the analyst checked it, rather than taking the color
    kit.handle({ t: 'labels', labels: [{ ...OFF, on: true }] })
    await tick()
    expect(colour.picks.map((p: any) => p.title)).toEqual(['Tool', 'Tactic'])
    // Space again unchecks it and turns it off
    await key('space')
    expect(colour.picks.map((p: any) => p.title)).toEqual(['Tool'])
    expect(shown().at(-1)).toEqual({ kind: 'show', id: 'k1', on: 'off' })
    await key('c')
    kit.handle({ t: 'labels', labels: [OFF] })
    await tick()
    // Filter by chooses it: it is turned on, and once it is on Color by keeps Tool
    await key('f')
    await key('down')
    await key('down')
    await key('return')
    expect(filter.by).toEqual({ label: 'k1', title: 'Tactic' })
    expect(shown().at(-1)).toEqual({ kind: 'show', id: 'k1', on: 'on' })
    kit.handle({ t: 'labels', labels: [{ ...OFF, on: true }] })
    await tick()
    expect(colour.by).toEqual({ field: 'tool', title: 'Tool' })
    // checked and unchecked in Color by while Filter by reads it, it stays on
    const before = shown().length
    await key('c')
    await key('down')
    await key('space')
    await key('space')
    expect(colour.picks.map((p: any) => p.title)).toEqual(['Tool'])
    expect(shown().length).toBe(before)
  })
})
