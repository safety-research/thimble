// What Matt asked for on 2026-10-07, drawn as rows of text: main's reply and its cards on Claude Code's own indent
// (column 2) with the `?` taking the ⏺'s cell; a side thread's panel showing what the thread is about above its chat (a
// card in its frame, a file's lines, a passage), clipped with `… N more`; a bar chart of two series by date, one row per
// date with the series stacked in their hues and its key below; every panel's one title row (`home › Threads`).
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import type { Seg } from '../draw'
import { fitPath, pathWidth } from '../nav'
import { COLORS, setTheme } from '../paint'
import { SERIES_DARK, SERIES_LIGHT } from '../palette.gen'
import { CWD, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

// the test's own output: its drawings, for a reader
declare const console: { log: (...args: unknown[]) => void }


/** A title row's words with the `↗` at its right end (SPEC-v2 3.8: every view's title row opens its object in the
 *  browser). */
const titled = (words: string) => new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +↗$`)
type M = Mounted<'terminal'>
type E = Engine
type Node = { type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

const PANEL = 'thimble'
const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: PANEL, component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 100, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const paneOf = (cols = 96, rows = 60) => ({ plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns: cols + 24, rows: rows + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { bodyRows: rows }, view: {} } }) as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function look($: E, cols = 96, rows = 60): Promise<M> {
  return (await $.ui.mount(paneOf(cols, rows))) as unknown as M
}

const append = ($: E, uuid: string, text: string) =>
  $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)

/** A turn of main's that made card `id` and answered `text` in row `uuid`. */
async function turn($: E, w: World, uuid: string, text: string, id = 'ff73e071'): Promise<void> {
  w.toolText = `card:${id}\n[out0: table]`
  await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
  await append($, uuid, text)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: text, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

// ------------------------------------------------------------------------------------------------ a text drawing

const wide = (s: string) => [...s].length

function wrap(s: string, w: number): string[] {
  const out: string[] = []
  for (const para of s.split('\n')) {
    let cur = ''
    for (const word of para.split(' ')) {
      const next = cur ? `${cur} ${word}` : word
      if (wide(next) <= w || !cur) cur = next
      else {
        out.push(cur)
        cur = word
      }
    }
    out.push(cur)
  }
  return out
}

const fit = (s: string, w: number) => (wide(s) <= w ? s + ' '.repeat(w - wide(s)) : `${[...s].slice(0, Math.max(0, w - 1)).join('')}…`)

function words(n: unknown): string {
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(words).join('')
  if (n && typeof n === 'object') {
    const o = n as Node
    return words(o.children ?? o.props?.children)
  }
  return ''
}

/** A drawn tree laid out in `w` columns about as a terminal shows it, for a reader of the test's output: Boxes stack or
 *  sit side by side with their widths, padding, margins, gaps and round borders; a Text wraps or is cut; Markdown drops
 *  its marks; a Client is what its module drew (`clients`, by key); a Box no row tall shows nothing; a Box drawn
 *  `display: none` shows only `hovered`, when a hover reveals it, and one `position: absolute` is painted over the row
 *  it stands in. */
function layout(n: unknown, w: number, clients: Map<string, unknown>, hovered: boolean): string[] {
  if (typeof n === 'string') return wrap(n, w)
  if (Array.isArray(n)) return n.flatMap(k => layout(k, w, clients, hovered))
  if (!n || typeof n !== 'object') return []
  const o = n as Node
  const p = o.props ?? {}
  if (p.display === 'none' && !(hovered && o.hover?.display === 'flex')) return []
  if (p.width === 0 || p.height === 0) return []
  if (o.type === 'Client') return layout(clients.get(String(p.key)), typeof p.width === 'number' ? Math.min(w, p.width) : w, clients, hovered)
  if (o.type === 'Button') return [String(p.label ?? '')]
  if (o.type === 'Input') return [`${String(p.value || p.placeholder || '')}▏`]
  if (o.type === 'Markdown') return wrap(String(p.text ?? '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1'), w)
  if (o.type === 'Text') {
    const s = words(o)
    return p.wrap === 'wrap' ? wrap(s, w) : s.split('\n').map(l => (wide(l) > w ? fit(l, w) : l))
  }
  const kids = ((o.children ?? (p.children as unknown[] | undefined) ?? []) as unknown[]).filter(k => k !== null && k !== undefined && k !== false)
  const border = p.borderStyle ? 2 : 0
  const padL = Number(p.paddingLeft ?? p.paddingX ?? 0)
  const padR = Number(p.paddingRight ?? p.paddingX ?? 0)
  const marginL = Number(p.marginLeft ?? 0)
  const outer = (typeof p.width === 'number' ? Math.min(w, p.width) : w) - marginL
  const inner = Math.max(1, outer - border - padL - padR)
  const absolute = (k: unknown) => (k as Node)?.props?.position === 'absolute'
  let rows: string[]
  if (p.flexDirection === 'column') {
    rows = []
    for (const k of kids) {
      const top = Number((k as Node)?.props?.marginTop ?? 0)
      const lines = layout(k, inner, clients, hovered)
      if (lines.length || top) rows.push(...Array.from({ length: top }, () => ''), ...lines)
    }
  } else {
    const gap = Number(p.columnGap ?? 0)
    const flow = kids.filter(k => !absolute(k))
    const fixed = flow.map(k => ((k as Node)?.props?.width as number | undefined) ?? null)
    const grow = flow.map(k => (k as Node)?.props?.flexGrow === 1 && !((k as Node).children ?? []).length)
    let left = inner - gap * Math.max(0, flow.length - 1)
    const drawn = flow.map((k, i) => {
      if (grow[i]) return null
      const top = Number((k as Node)?.props?.marginTop ?? 0)
      const lines = [...Array.from({ length: top }, () => ''), ...layout(k, fixed[i] ?? Math.max(1, left), clients, hovered)]
      left -= fixed[i] ?? Math.max(0, ...lines.map(wide))
      return lines
    })
    const widths = drawn.map((d, i) => (d === null ? Math.max(0, left) : fixed[i] ?? Math.max(0, ...d.map(wide))))
    const height = Math.max(1, ...drawn.map(d => d?.length ?? 0))
    rows = Array.from({ length: height }, (_, y) => drawn.map((d, i) => fit(d?.[y] ?? '', widths[i]!)).join(' '.repeat(gap)).replace(/\s+$/, ''))
    if (drawn.every(d => d !== null && !d.length)) rows = []
    // a Box out of the flow, painted over the row from its `left`
    for (const k of kids.filter(absolute)) {
      const at = Number((k as Node).props?.left ?? 0)
      layout(k, inner, clients, hovered).forEach((l, y) => {
        const row = [...(rows[y] ?? '').padEnd(at + wide(l))]
        ;[...l].forEach((ch, x) => (row[at + x] = ch))
        rows[y] = row.join('')
      })
    }
  }
  rows = rows.map(r => ' '.repeat(marginL + padL) + r)
  if (border) rows = [`╭${'─'.repeat(outer - 2)}╮`, ...rows.map(r => `│${fit(r.slice(marginL), outer - 2)}│`), `╰${'─'.repeat(outer - 2)}╯`].map(r => ' '.repeat(marginL) + r)
  return rows
}

/** A mounted drawing as rows of text, `cols` wide: every Client's drawing read first, at the width it is laid out at. */
async function screen(m: M, cols: number, hovered = false): Promise<string[]> {
  const tree = await m.drawn()
  const json = JSON.stringify(tree)
  const keys = [...json.matchAll(/"type":"Client","props":\{"key":"([^"]+)"/g)].map(x => x[1]!)
  const widths = new Map([...json.matchAll(/"type":"Client","props":\{"key":"([^"]+)"[^}]*?"width":(\d+)/g)].map(x => [x[1]!, Number(x[2])]))
  const clients = new Map<string, unknown>()
  for (const k of keys) {
    if (widths.get(k)) await m.resize({ columns: widths.get(k)!, rows: 60, in: k } as never).catch(() => undefined)
    clients.set(k, await m.drawn({ in: k }).catch(() => null))
  }
  return layout(tree, cols, clients, hovered).map(r => r.replace(/\s+$/, ''))
}

function print(what: string, rows: string[]): string {
  const text = rows.join('\n')
  console.log(`\n--- ${what}\n${text}\n---`)
  return text
}

const at = (rows: string[], text: string) => rows.findIndex(r => r.includes(text))

// ------------------------------------------------------------------------------------------------ main's chat

test("main's reply and its card stand on Claude Code's own indent, column 2; the `?` takes the ⏺'s cell, never more indent", async ($, on) => {
  // Matt, 2026-10-07: "can we keep the same left indent for thimble content while keeping our ability to show the
  // question mark? we could still indent 2 chars and replace the dot with ? when they overlap"
  const w = world(on)
  await start($, w)
  await turn($, w, 'r1', 'The export holds most of its pages in one wiki, dse.\n\nIts revisions follow the same split.')
  let ui = (await $.ui.mount(MESSAGE('r1', 'The export holds most of its pages in one wiki, dse.\n\nIts revisions follow the same split.'))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', 'The export holds most of its pages in one wiki, dse.\n\nIts revisions follow the same split.'))) as unknown as M
  const rest = await screen(ui, 100)
  print('a reply with its card, 100 columns', rest)
  // the ⏺ at column 0 and the prose at 2, as Claude Code draws its own replies; the card's border, its takeaway and
  // the footer on the same edge
  expect(rest[0]).toBe('⏺ The export holds most of its pages in one wiki, dse.')
  expect(rest[2]).toBe('  Its revisions follow the same split.')
  expect(rest[at(rest, '╭')]).toMatch(/^ {2}╭─+╮$/)
  // the fixtures' thread t1 was asked about the card: its ↳ in the margin beside the card's title
  expect(rest[at(rest, 'What does the export hold per wiki?')]).toMatch(/^↳ │ What does the export hold per wiki\? +│$/)
  expect(rest[at(rest, '1 card')]).toMatch(/^ {2}1 card {2}ask about this answer ›$/)
  // the card's border ends where the prose may: the terminal's width less 2
  expect(rest[at(rest, '╭')]!.length).toBe(98)
  // under the pointer the passage's `?` lies over the ⏺, in the same cell; a later passage's `?` in the margin
  const hover = await screen(ui, 100, true)
  print('the same reply under the pointer (every passage shows its `?`)', hover)
  expect(hover[0]).toBe('? The export holds most of its pages in one wiki, dse.')
  expect(hover[2]).toBe('? Its revisions follow the same split.')
  // the first row's margin: the ⏺, and the `?` drawn out of the flow over it, shown only under the pointer
  const first = (await ui.find({ type: 'Box', key: 'row-1-0' })) as Node
  const margin = ((first.children ?? []) as Node[])[0]!
  expect(margin.props).toMatchObject({ width: 2 })
  const marks = (margin.children ?? []) as Node[]
  expect(words(marks[0])).toBe('⏺')
  expect(marks[1]!.props).toMatchObject({ position: 'absolute', top: 0, left: 0, display: 'none' })
  expect(marks[1]!.hover).toEqual({ display: 'flex' })
  await ui.unmount()
})

test("the person's message stays Claude Code's own row, and the reply under it keeps the engine's blank row above it", async ($, on) => {
  // Matt, 2026-10-16: in the build's shots the reply sat right under the person's message, with no blank row between
  const w = world(on)
  await start($, w)
  await turn($, w, 'r1', 'The export holds most of its pages in one wiki, dse.')
  const you = await $.ui.mount({ plugin: PANEL, component: 'UserMessage', requestId: 'u1', surface: 'terminal', viewport: { columns: 100, rows: 40 }, props: { text: 'What does the export hold?\n\nOne line.', origin: { kind: 'composer' }, isExpanded: false } } as never)
  expect(shown(await you.drawn())).toBe('(the engine row)')
  await you.unmount()
  // the engine draws its reply row with `marginTop: 1`; thimble's tree takes that row's place, so it carries the margin
  const ui = (await $.ui.mount(MESSAGE('r1', 'The export holds most of its pages in one wiki, dse.'))) as unknown as M
  await w.clock.advance(300)
  const root = (await ui.drawn()) as Node
  expect(root.props).toMatchObject({ flexDirection: 'column', marginTop: 1 })
  expect((await screen(ui, 100))[0]).toBe('⏺ The export holds most of its pages in one wiki, dse.')
  await ui.unmount()
})

test("a passage a side thread was asked about keeps its `↳` in the ⏺'s cell on the reply's first row", async ($, on) => {
  // the fixtures' thread t2 was asked about the words `the deletions`
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('m1', 'the deletions\n\nThey came on one day.'))) as unknown as M
  await w.clock.advance(300)
  const rows = await screen(ui, 100)
  print('a reply whose first passage has a thread', rows)
  expect(rows[0]).toBe('↳ the deletions')
  expect(rows[2]).toBe('  They came on one day.')
  expect(await ui.find({ type: 'Client', key: 'asked-1-0' })).toBeDefined()
  await ui.unmount()
})

// ------------------------------------------------------------------------------------------------ a bar chart by date

const BY_DATE: ThimbleCell = {
  id: 'b1date00',
  kind: 'plot',
  title: 'How many pages were saved and deleted each day?',
  status: 'ok',
  outputs: [
    {
      'application/vnd.vegalite.v6.json': {
        mark: 'bar',
        encoding: { x: { field: 'day', type: 'temporal' }, y: { field: 'events', type: 'quantitative' }, color: { field: 'event', type: 'nominal' } },
        data: {
          values: [
            { day: '2026-05-24T00:00:00+00:00', event: 'page saved', events: 120 },
            { day: '2026-05-24T00:00:00+00:00', event: 'page deleted', events: 14 },
            { day: '2026-05-25T00:00:00+00:00', event: 'page saved', events: 300 },
            { day: '2026-05-25T00:00:00+00:00', event: 'page deleted', events: 40 },
            { day: '2026-05-26T00:00:00+00:00', event: 'page saved', events: 80 },
            { day: '2026-05-26T00:00:00+00:00', event: 'page deleted', events: 2 },
          ],
        },
      },
    },
  ],
}

test('a bar chart of two series by date: one row per date in words, its series stacked in their hues, the key below', async () => {
  // seen on collusion-wiki (2026-10-07): each date's ISO stamp as the label, each date once per series
  const { card } = cardOfCell(BY_DATE)
  const lay = cardLayout(card, 70, -1)
  const rows = lay.lines.map(l => l.map(s => s.s).join(''))
  print('a bar card of page saved and page deleted by day, 70 columns', rows)
  // dates as the browser's axis writes them, every time midnight: the day alone, in words
  expect(rows.slice(0, 3).map(r => r.split('  ')[0])).toEqual(['May 24', 'May 25', 'May 26'])
  expect(rows.join('\n')).not.toContain('2026-05')
  expect(rows.join('\n')).not.toContain('T00:00')
  // one row per date, its total at the right, the key on the row under the bars
  expect(rows).toHaveLength(4)
  expect(rows[1]).toMatch(/ 340$/)
  expect(rows[3]).toBe('● page saved  ● page deleted')
  // each row's bar: the first series in the first hue, the second after it in the second, nothing between them
  const parts = lay.lines[0]!.filter(s => /^[█▏▎▍▌▋▊▉]+$/.test(s.s))
  expect(parts.map(s => s.fg)).toEqual([COLORS.series[0], COLORS.series[1]])
  const key = lay.lines[3]!.filter(s => s.s === '● ').map(s => s.fg)
  expect(key).toEqual([COLORS.series[0], COLORS.series[1]])
  // the busiest day's bar fills the bars' room; the others in proportion
  const bar = (r: string) => [...r].filter(ch => /[█▏▎▍▌▋▊▉]/.test(ch)).length
  expect(bar(rows[1]!)).toBeGreaterThan(bar(rows[0]!))
  expect(bar(rows[0]!)).toBeGreaterThan(bar(rows[2]!))
  // the pointer on each part reads its series: `May 24 · page deleted  14 events`
  const x0 = rows[0]!.indexOf('█')
  const saved = lay.hit(x0, 0)
  const deleted = lay.hit(x0 + parts[0]!.s.length, 0)
  expect(lay.items[saved]).toMatchObject({ label: 'May 24 · page saved', value: '120 events' })
  expect(lay.items[deleted]).toMatchObject({ label: 'May 24 · page deleted', value: '14 events' })
  // a time that is not midnight keeps its clock
  const noon = cardOfCell({ ...BY_DATE, outputs: [{ 'application/vnd.vegalite.v6.json': { mark: 'bar', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'n', type: 'quantitative' } }, data: { values: [{ t: '2026-05-24T00:00:00Z', n: 3 }, { t: '2026-05-24T12:30:00Z', n: 5 }] } } }] }).card
  expect(cardLayout(noon, 60, -1).lines.map(l => l.map(s => s.s).join('').split('  ')[0])).toEqual(['May 24 00:00', 'May 24 12:30'])
})

test('the bar under the pointer: its name in inverse and its bar in the text color, nothing else on its row or any other lit; the same in the light theme', () => {
  const single = cardOfCell({
    ...BY_DATE,
    outputs: [{ 'application/vnd.vegalite.v6.json': { mark: 'bar', encoding: { x: { field: 'wiki', type: 'nominal' }, y: { field: 'pages', type: 'quantitative' } }, data: { values: [{ wiki: 'dse', pages: 3200 }, { wiki: 'probier', pages: 900 }, { wiki: 'sandbox', pages: 479 }] } } }],
  }).card
  const stacked = cardOfCell(BY_DATE).card
  const lit = (s: Seg) => Boolean(s.inv || s.bg || s.b || s.u || s.fg === COLORS.text)
  const litOf = (lines: Seg[][]) => lines.flatMap((l, y) => l.filter(lit).map(s => ({ y, s: s.s, how: s.inv ? 'inverse' : s.fg === COLORS.text ? 'text' : 'other' })))
  const BAR = /^[█▏▎▍▌▋▊▉]+$/
  try {
    for (const theme of ['light', 'dark'] as const) {
      setTheme(theme)
      // at rest nothing is lit
      expect(litOf(cardLayout(single, 96, -1).lines)).toEqual([])
      // one series: the row of `probier` (item 1) lights its name and its bar, not its gap, its value or another row
      const hot = cardLayout(single, 96, 1).lines
      const got = litOf(hot)
      expect(got.map(g => [g.y, g.how])).toEqual([
        [1, 'inverse'],
        [1, 'text'],
      ])
      expect(got[0]!.s).toBe('probier')
      expect(got[1]!.s).toMatch(BAR)
      expect(hot[1]!.filter(s => !lit(s)).every(s => !s.s.trim() || /^[\d,]+$/.test(s.s.trim()))).toBe(true)
      // the other rows' bars keep the theme's first series hue (the light theme's own, not the dark one's)
      expect(hot[0]!.find(s => BAR.test(s.s))!.fg).toBe(COLORS.series[0])
      expect(COLORS.series[0]).toBe(theme === 'light' ? SERIES_LIGHT[0] : SERIES_DARK[0])
      // stacked: only the part under the pointer turns the text color; the row's other part keeps its hue
      const lay = cardLayout(stacked, 96, -1)
      const x0 = lay.lines[0]!.map(s => s.s).join('').indexOf('█')
      const deleted = lay.hit(x0 + lay.lines[0]!.find(s => BAR.test(s.s))!.s.length, 0)
      const part = cardLayout(stacked, 96, deleted).lines
      expect(litOf(part).map(g => [g.y, g.how, g.how === 'inverse' ? g.s : 'bar'])).toEqual([
        [0, 'inverse', 'May 24'],
        [0, 'text', 'bar'],
      ])
      expect(part[0]!.filter(s => BAR.test(s.s)).map(s => s.fg)).toEqual([COLORS.series[0], COLORS.text])
    }
  } finally {
    setTheme('dark')
  }
})

test("a line chart over dates names its x in words, as a bar chart's labels read; its citations keep the rows' stamps", async () => {
  // seen on collusion-wiki (2026-10-10): thimble.chart('line') of weekly saves, its axis `2026-05-18T00:00:00 …`
  const weeks = ['2026-05-18T00:00:00', '2026-05-25T00:00:00', '2026-06-01T00:00:00', '2026-06-08T00:00:00', '2026-06-15T00:00:00']
  const cell: ThimbleCell = {
    id: 'l1week00',
    kind: 'plot',
    title: 'How many saves did the busiest accounts make each week?',
    status: 'ok',
    outputs: [
      {
        'application/vnd.vegalite.v6.json': {
          mark: 'line',
          encoding: { x: { field: 'week', type: 'temporal' }, y: { field: 'saves', type: 'quantitative' }, color: { field: 'account', type: 'nominal' } },
          data: { values: weeks.flatMap((week, i) => [{ week, account: 'AgentRelent', saves: i * 70 }, { week, account: 'MapHelper', saves: i * 40 }]) },
        },
      },
    ],
  }
  const { card } = cardOfCell(cell)
  const lay = cardLayout(card, 70, -1)
  const rows = lay.lines.map(l => l.map(s => s.s).join(''))
  print('a line card of two accounts by week, 70 columns', rows)
  // the axis ticks at a round step of the calendar, a week from each Sunday, as the browser's axis does (axes.test.ts)
  const axis = rows.find(r => r.includes('May'))!
  expect(axis.trim().split(/\s{2,}/)).toEqual(['May 24', 'May 31', 'Jun 7', 'Jun 14'])
  expect(rows.join('\n')).not.toContain('2026-')
  expect(lay.items[0]).toMatchObject({ label: 'May 18', value: 'AgentRelent 0', open: 'card:l1week00#AgentRelent/2026-05-18T00:00:00' })
})

// ------------------------------------------------------------------------------------------------ the title row

test("every panel's header is one title row: the path, earlier steps dim and a click away, the current step in the accent and bold; no `‹ back`", async ($, on) => {
  // Matt, 2026-10-07: "If we show Home > Threads (where threads is bold & colored) where home is clickable, we don't need
  // to show < back and home > threads above. can just be one line for title. it already says 'b to go back'"
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = await look($)
  let rows = await screen(pane, 96)
  print('home, 96 columns (the first rows)', rows.slice(0, 4))
  expect(rows[0]).toMatch(/^ {3}Home +show all threads {2}1 new {2}↗$/)
  expect(rows[1]!.trim()).toMatch(/^─+$/)
  await pane.press({ key: 'threads' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane, 96)
  print('the threads panel', rows.slice(0, 4))
  expect(rows[0]).toMatch(titled('   home › Threads'))
  // no subtitle line: the root's row holds its count of threads and how many are new
  expect(rows[1]!.trim()).toMatch(/^─+$/)
  expect(rows[2]).toMatch(/^ {3}main +2 threads {2}1 new$/)
  expect(rows.join('\n')).not.toContain('‹ back')
  // `home` dim and a click away; `Threads` in the accent and bold
  const way = JSON.stringify(await pane.find({ type: 'Box', key: 'way' }))
  expect(way).toContain('{"type":"Button","props":{"key":"crumb-home","label":"home","plain":true,"dimColor":true}')
  expect(way).toContain('{"type":"Text","props":{"color":"suggestion","bold":true},"children":["Threads"]}')
  // b still goes back
  expect(await pane.find({ type: 'Button', key: 'hk-back' })).toBeDefined()
  await pane.press({ key: 'hk-back' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  expect((await screen(pane, 96))[0]).toMatch(/^ {3}Home /)
  await pane.unmount()
  // a document from the documents list: `home › documents › "…"`, the document's title the current step
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  pane = await look($)
  await pane.press({ key: 'doc-open-0' })
  await w.clock.settle()
  await pane.unmount()
  await w.clock.advance(1100)
  pane = await look($)
  rows = await screen(pane, 96)
  print('a document', rows.slice(0, 3))
  expect(rows[0]).toMatch(titled('   home › documents › "Agents used the dse wiki as a relay"'))
  expect(rows[1]!.trim()).toMatch(/^─+$/)
  await pane.unmount()
  // in a narrow pane the earlier steps shorten first, then the current one is cut with `…`
  pane = await look($, 40)
  rows = await screen(pane, 40)
  print('the document in a pane 40 columns wide', rows.slice(0, 2))
  expect(rows[0]).toMatch(titled('   home › … › "Agents used the dse…"'))
  await pane.unmount()
})

test('the path fits its row: earlier steps shorten first (cut to 12 cells, then folded into `…`), then the current step is cut', () => {
  const doc = ['home', 'documents', '"The reviewer\'s count of 3,898 pages deleted on 16 June"', 'citation card "How many saves and deletions does each wiki have?" output line 1']
  const show = (f: (string | null)[]) => f.map(s => s ?? '…').filter((s, i, a) => !(s === '…' && a[i - 1] === '…')).join(' › ')
  const [w140, w110, w60] = [140, 110, 60].map(r => fitPath(doc, r))
  console.log(`\n--- the path at 140, 110 and 60 columns\n${show(w140!)}\n${show(w110!)}\n${show(w60!)}\n---`)
  // an earlier step cut to its room first, the current step whole
  expect(w140).toEqual(['home', 'documents', '"The reviewer\'s count of 3,898…"', doc[3]])
  // then the earlier steps down to 12 cells and folded, oldest first, home kept; the current step still whole
  expect(w110).toEqual(['home', null, '"The revie…"', doc[3]])
  // only then the current step, cut at a word, its quotation marks kept
  expect(w60).toEqual(['home', null, null, 'citation card "How many saves and deletions…"'])
  for (const [f, room] of [[w140!, 140], [w110!, 110], [w60!, 60]] as const) expect(pathWidth(f)).toBeLessThanOrEqual(room)
})

// ------------------------------------------------------------------------------------------------ a thread's subject

/** A card of `n` rows, a table the subject cuts to its first rows. */
function tallCard(w: World, n: number): void {
  w.cells.t0tall00 = {
    id: 't0tall00',
    notebook: 'g1',
    kind: 'table',
    title: 'How many revisions did each label make?',
    takeaway: 'AgentRelent made the most.',
    labels: [],
    created_by: 'main',
    status: 'ok',
    outputs: [{ 'application/vnd.thimble.frame+json': { columns: ['label', 'revisions'], index: null, label: 'label', rows: Array.from({ length: n }, (_, i) => [`Agent${String(i + 1).padStart(2, '0')}`, 300 - i]), total: n, view: { columns: ['revisions'] } } }],
  }
}

test('a new thread about a card shows the card in its frame above the field: its title bold, a blank row, the plot; a tall one cut with `… N more`', async ($, on) => {
  // Matt, 2026-10-07: "when you open a thread about something (paragraph of text, a card, a quote, etc.) and want to
  // respond below, keep that thing above the chat so I know what I'm referencing"
  const w = world(on)
  tallCard(w, 12)
  await start($, w)
  await turn($, w, 'r1', 'Here.', 't0tall00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.press({ key: 'ask-card-0' })
  await ui.unmount()
  await w.clock.settle()
  let pane = await look($)
  let rows = await screen(pane, 96)
  print('a new thread about a tall card', rows)
  expect(rows[0]).toMatch(titled('   home › New thread'))
  expect(rows[1]).toBe('   about card "How many revisions did each label make?"')
  expect(rows[2]!.trim()).toMatch(/^─+$/)
  // the card in its frame on the type area's edge: its title, a blank row, the first six rows of its table, then
  // `… N more` for the rows left out (its other rows and its takeaway)
  expect(rows[3]).toMatch(/^ {3}╭─+╮$/)
  expect(rows[4]).toMatch(/^ {3}│ How many revisions did each label make\? +│$/)
  expect(rows[5]).toMatch(/^ {3}│ +│$/)
  expect(rows[6]).toMatch(/│ label +revisions +│$/)
  expect(rows.join('\n')).toContain('Agent04')
  expect(rows.join('\n')).not.toContain('Agent05')
  expect(rows.join('\n')).not.toContain('AgentRelent made the most.')
  const more = rows.find(r => /… \d+ more/.test(r))!
  expect(more).toMatch(/^ {3}│ … 9 more +│$/)
  // then the entry box: a rule, `❯` and the field, a rule
  const field = at(rows, 'type your question')
  expect(rows[field]).toBe(' ❯ type your question▏')
  expect(rows[field - 1]).toMatch(/^ ─+$/)
  expect(rows[field + 1]).toMatch(/^ ─+$/)
  expect(rows[field - 2]).toMatch(/^ {3}╰─+╯$/)
  // `… N more` shows the card whole, its takeaway too
  await pane.press({ key: (((await pane.findAll({ type: 'Button' })) as { key?: string }[]).find(b => /^more-/.test(String(b.key)))!).key! })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane, 96)
  print('the same card shown whole', rows)
  expect(rows.join('\n')).toContain('Agent12')
  expect(rows.join('\n')).toContain('AgentRelent made the most.')
  expect(rows.join('\n')).not.toMatch(/… \d+ more/)
  await pane.unmount()
})

test("a thread's subject: one dim `about` row above its chat; v shows the card it is about whole between that row and its first question", async ($, on) => {
  // Matt, 2026-10-07: "keep that thing above the chat so I know what I'm referencing"; 2026-10-15: the chat's
  // information hierarchy, which the subject drawn whole above it muddled
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  let pane = await look($)
  await pane.press({ key: 'thread-open-t1' })
  await w.clock.settle()
  await pane.unmount()
  await w.clock.advance(1100)
  pane = await look($)
  let rows = await screen(pane, 96)
  print('a thread about a card', rows)
  // the thread named by its first question
  expect(rows[0]).toMatch(titled('   home › threads › "why is events.jsonl so much bigger?"'))
  let about = at(rows, 'about card "What does the export hold per wiki?"')
  expect(about).toBeGreaterThan(0)
  // the card is not drawn: a blank row, then the first question
  expect(rows[about + 1]).toBe('')
  expect(rows[about + 2]).toBe(' ❯ why is events.jsonl so much bigger?')
  expect(rows.join('\n')).not.toContain('The export holds 4579')
  // v: the card right under it, in its frame, its takeaway inside; then a blank row, the first question and its answer
  await pane.press({ key: 'hk-subject' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane, 96)
  print('the same thread with its card shown', rows)
  about = at(rows, 'about card "What does the export hold per wiki?"')
  expect(rows[about + 1]).toMatch(/^ {3}╭─+╮$/)
  expect(rows[about + 2]).toMatch(/^ {3}│ What does the export hold per wiki\? +│$/)
  const end = rows.findIndex((r, i) => i > about && /^ {3}╰─+╯$/.test(r))
  expect(rows.slice(about, end).join('\n')).toContain('The export holds 4579')
  expect(rows[end + 1]).toBe('')
  expect(rows[end + 2]).toBe(' ❯ why is events.jsonl so much bigger?')
  expect(rows.slice(end + 3).join('\n')).toContain('one per event.')
  await pane.unmount()
})

test("a thread about a file's line shows on v that line lit, with two lines on each side; one about a passage, its words", async ($, on) => {
  const w = world(on)
  w.states.threads.push(
    { id: 't4', kind: 'thread', role: 'thread', title: 'four wikis?', anchor: 'README.md#L3', anchor_text: 'The corpus is an export of four wikis.', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 1 } as never,
    { id: 't5', kind: 'thread', role: 'thread', title: 'why June?', anchor: null, anchor_text: 'Most saves came in June, when the agents were busiest on the dse wiki and its board. Few came later, and none after the export.', parent: 'main', created_at: '2026-10-06T10:06:00+00:00', running: false, answers: 1, seen: 1 } as never,
  )
  w.chats.t4 = { meta: w.states.threads.at(-2), events: [{ type: 'user', text: 'four wikis?' }, { type: 'done', result: 'Yes, four.' }] }
  w.chats.t5 = { meta: w.states.threads.at(-1), events: [{ type: 'user', text: 'why June?' }, { type: 'done', result: 'The relay ran then.' }] }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  let pane = await look($)
  await pane.press({ key: 'thread-open-t4' })
  await w.clock.settle()
  await pane.unmount()
  await w.clock.advance(1100)
  pane = await look($)
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('v to show the lines')
  await pane.press({ key: 'hk-subject' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  let rows = await screen(pane, 96)
  print("a thread about README.md line 3", rows.slice(rows.findIndex(r => r.includes('about '))))
  const about = at(rows, 'about ')
  // the cited line in the text color and the lines around it dim, numbered, nested at A2
  expect(rows[about + 1]).toBe('     2')
  expect(rows[about + 2]).toBe('     3  An export of 4,579 wiki pages and their revisions.')
  expect(rows[about + 3]).toBe('     4  Four wikis.')
  expect(rows[about + 4]).toBe('')
  expect(rows[about + 5]).toBe(' ❯ four wikis?')
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["An export of 4,579 wiki pages and their revisions."]}')
  await pane.press({ key: 'thread-open-t5' })
  await w.clock.settle()
  await pane.unmount()
  await w.clock.advance(1100)
  pane = await look($)
  // the passage on its `about` row, cut at a word, then a blank row; v shows it whole under that row
  rows = await screen(pane, 96)
  const cutRow = at(rows, 'about "Most saves')
  expect(rows[cutRow]).toMatch(/^ {3}about "Most saves came in June, when the agents [^"]*…"$/)
  expect(rows[cutRow + 1]).toBe('')
  await pane.press({ key: 'hk-subject' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane, 96)
  print('a thread about a passage', rows.slice(rows.findIndex(r => r.includes('about '))))
  const a5 = at(rows, 'about "Most saves')
  // the passage whole under its name, wrapped at the type area, then a blank row and the question
  expect(rows[a5 + 1]).toBe('   Most saves came in June, when the agents were busiest on the dse wiki and its board. Few')
  expect(rows[a5 + 2]).toBe('   came later, and none after the export.')
  expect(rows[a5 + 3]).toBe('')
  expect(rows[a5 + 4]).toBe(' ❯ why June?')
  await pane.unmount()
})

test("a long passage is cut to six rows and `… N more`, which shows it whole", async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = Array.from({ length: 9 }, (_, i) => `Line ${i + 1} of the section says one thing about the wiki.`).join('\n')
  const ui = (await $.ui.mount(MESSAGE('m1', `## The data\n\n${text}`))) as unknown as M
  await ui.press({ key: 'ask-1-0' })
  await ui.unmount()
  await w.clock.settle()
  let pane = await look($)
  let rows = await screen(pane, 96)
  print('a new thread about a section', rows)
  expect(rows[1]).toBe('   about the section "The data"')
  expect(rows[3]).toBe('   The data')
  expect(rows[8]).toBe('   Line 5 of the section says one thing about the wiki.')
  expect(rows[9]).toBe('   … 4 more')
  expect(JSON.stringify(await pane.drawn())).toMatch(/\{"type":"Text","props":\{"bold":true\},"children":\["The data"\]\}/)
  await pane.press({ key: (((await pane.findAll({ type: 'Button' })) as { key?: string }[]).find(b => /^subject-more-/.test(String(b.key)))!).key! })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane, 96)
  expect(rows.join('\n')).toContain('Line 9 of the section')
  expect(rows.join('\n')).not.toContain('… 4 more')
  expect(await pane.find({ type: 'Input', key: 'ask-new' })).toBeDefined()
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ a side thread's chat

// Matt, 2026-10-15, on a side thread in terminal mode: "presentation of the chat has bad information hierarchy". His
// thread: a passage of main's reply asked about, one question, an answer that cites the card it made by a chip alone.
const PASSAGE = 'The files show 7 participants, P1 to P7. Each one has a screen recording and a transcript. P6 and P7 also have a return/ folder of thimble session logs, which hold events, telemetry, hooks and a report. The corpus has 1,303 files in all, 3.6 GB.'
const ASKED = "what's the breakdown of file size? 3.6gb is mostly video?"
const SIZES = "How much of the corpus's 3.6 GB is video, and how much is logs and transcripts?"
const ANSWERED = 'Yes. The 7 screen recordings are about 3.7 GB, 95 of every 100 bytes. The thimble session logs are 174 MB and the 7 transcripts are under 1 MB [[card:s1zes000]].'

/** The screenshot's thread (`tz`) and its card in world `w`, beside main and the threads `others`; `more`, a later
 *  turn's records after its first answer. */
function sizeThread(w: World, others: Record<string, unknown>[] = [], more: Record<string, unknown>[] = []): void {
  w.cells.s1zes000 = {
    id: 's1zes000',
    notebook: 'g1',
    kind: 'plot',
    title: SIZES,
    takeaway: 'Yes, it is mostly video. The 7 recordings take 3,695.5 MB, 95.5% of the 3,870.2 MB total.',
    labels: [],
    created_by: 'chat:tz',
    ts: '2026-10-06T10:06:00+00:00',
    status: 'ok',
    outputs: [{ 'application/vnd.vegalite.v6.json': { mark: { type: 'bar' }, encoding: { y: { field: 'part', type: 'nominal', sort: null }, x: { field: 'MB', type: 'quantitative' } }, data: { name: 'd1' }, datasets: { d1: [{ part: 'video (.mp4)', MB: 3695.5 }, { part: 'session logs', MB: 174.4 }, { part: 'transcripts (.md)', MB: 0.3 }] } }, 'text/plain': '<VegaLite 6 object>' }],
  }
  const meta = { id: 'tz', kind: 'thread', role: 'thread', title: 'the-files-show-7', anchor: null, anchor_text: PASSAGE, anchor_surface: 'terminal', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1 + more.filter(x => x.type === 'done').length, seen: 9, question: ASKED, turn: 'answered' }
  w.states.threads = [w.states.threads[0]!, meta, ...others] as never
  const events = [
    { type: 'user', text: ASKED, by: 'terminal' },
    { type: 'tool_use', id: 'u1', name: 'mcp__plugin_thimble_thimble__add_card', input: { question: SIZES } },
    { type: 'tool_result', id: 'u1', summary: 'card:s1zes000', cell_id: 's1zes000' },
    { type: 'text', delta: ANSWERED, reply: true, by: 'terminal' },
    { type: 'done', result: ANSWERED },
    ...more,
  ]
  // the whole chat, as the route answers with `total` (the fixtures' route gives every event, past `--after` or not)
  w.chats.tz = { meta, events, total: events.length }
}

/** The thread `id` opened from the threads panel, drawn once its chat and its cards are read. */
async function openedThread($: E, w: World, id: string): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  let pane = await look($)
  await pane.press({ key: `thread-open-${id}` })
  await w.clock.settle()
  for (let i = 0; i < 3; i++) {
    await pane.unmount()
    await w.clock.advance(1100)
    pane = await look($)
    if (!JSON.stringify(await pane.drawn()).includes('reading the card')) break
  }
  return pane
}

const ruled = (r: string | undefined) => /^ {3}─+$/.test(r ?? '')
// an entry box's rule: from the margin's edge, as Claude Code's prompt box spans its column
const boxRule = (r: string | undefined) => /^ ─+$/.test(r ?? '')

test("a side thread alone: its question the title, one dim `about` row under it, then the chat as Claude Code draws one; no thread list", async ($, on) => {
  const w = world(on)
  sizeThread(w)
  await start($, w)
  let pane = await openedThread($, w, 'tz')
  let rows = await screen(pane, 96)
  print("Matt's side thread, alone", rows)
  const text = rows.join('\n')
  // the title row names the thread by its question; under it what it is about, dim, on one row, cut at a word
  expect(rows[0]).toMatch(titled(`   home › threads › "${ASKED}"`))
  expect(rows[1]).toBe('   about "The files show 7 participants, P1 to P7. Each one has a…"')
  expect(ruled(rows[2])).toBe(true)
  expect(JSON.stringify(await pane.find({ key: 'thread-about' }))).toContain('"dimColor":true')
  // one thread: no list of threads above it, and the passage is not drawn again in full
  expect(await pane.find({ key: 'm:threads-tree' })).toBeUndefined()
  expect(text).not.toContain('1 thread')
  expect(text).not.toContain('hold events, telemetry')
  // the question as Claude Code draws a prompt: `❯` in the margin, the words on the prompt's background, unquoted
  expect(rows[3]).toBe(` ❯ ${ASKED}`)
  const band = JSON.stringify(await pane.find({ key: 'm:thread-q-1' }))
  expect(band).toContain(`"backgroundColor":"${COLORS.prompt}"`)
  // a blank row, then the answer after Claude Code's ⏺, on the type area's edge
  expect(rows[4]).toBe('')
  expect(rows[5]).toMatch(/^ ⏺ Yes\. The 7 screen recordings are about 3\.7 GB/)
  // the card the answer cites alone is drawn where it is cited, once, a blank row above it; no `[ card ]`
  const top = rows.findIndex(r => /^ {3}╭─+╮$/.test(r))
  expect(top).toBeGreaterThan(5)
  expect(rows[top - 1]).toBe('')
  expect(rows[top - 2]).toMatch(/are under 1 MB\.$/)
  expect(rows[top + 1]).toContain(SIZES.slice(0, 40))
  expect(text).not.toContain('[ card ]')
  expect(text).not.toContain('[[card')
  expect(text.split(SIZES.slice(0, 40)).length - 1).toBe(1)
  // the entry box under the chat, as Claude Code's prompt box: a rule from the margin's edge, `❯` in the margin and the
  // field, a rule; the keys in one dim row, `v` naming what it shows
  const bottom = rows.findIndex((r, i) => i > top && /^ {3}╰─+╯$/.test(r))
  expect(boxRule(rows[bottom + 1])).toBe(true)
  expect(rows[bottom + 2]).toBe(' ❯ ask a follow-up question▏')
  expect(boxRule(rows[bottom + 3])).toBe(true)
  // its rules end where the panel's do
  expect(rows[bottom + 1]!.length).toBe(rows[2]!.length)
  expect(JSON.stringify(await pane.find({ type: 'Input', key: (((await pane.findAll({ type: 'Input' })) as { key?: string }[]).find(i => /^ask-/.test(String(i.key)))!).key! }))).toContain('"rows":2')
  const hint = shown(await pane.find({ key: 'h-hints' })).trim()
  expect(hint).toBe('a to ask · v to show the passage · b to go back · x to close')
  // v shows the passage whole, under the rule and above the question; v again hides it
  await pane.press({ key: 'hk-subject' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane, 96)
  print('the same thread with its passage shown', rows.slice(0, 9))
  expect(rows[1]).toBe('   about "The files show 7 participants, P1 to P7. Each one has a…"')
  expect(ruled(rows[2])).toBe(true)
  expect(rows[3]).toBe('   The files show 7 participants, P1 to P7. Each one has a screen recording and a transcript.')
  const end = at(rows, 'The corpus has 1,303 files in all, 3.6 GB.')
  expect(rows[end + 1]).toBe('')
  expect(rows[end + 2]).toBe(` ❯ ${ASKED}`)
  expect(shown(await pane.find({ key: 'h-hints' })).trim()).toContain('v to hide the passage')
  await pane.press({ key: 'hk-subject' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane, 96)
  expect(rows[3]).toBe(` ❯ ${ASKED}`)
  await pane.unmount()
})

test("several threads: the list one row a thread, then a rule, then the open thread's `about` row and its chat", async ($, on) => {
  const w = world(on)
  const other = { id: 'ty', kind: 'thread', role: 'thread', title: 'which-took-longest', anchor: null, anchor_text: 'P3 took the longest session.', parent: 'main', created_at: '2026-10-06T10:07:00+00:00', running: false, answers: 1, seen: 1, question: 'Which participant took longest?', turn: 'answered' }
  sizeThread(w, [other])
  w.chats.ty = { meta: other, events: [{ type: 'user', text: 'Which participant took longest?' }, { type: 'text', delta: 'P3, at 48 minutes.', reply: true }, { type: 'done', result: 'P3, at 48 minutes.' }], total: 3 }
  await start($, w)
  const pane = await openedThread($, w, 'tz')
  const rows = await screen(pane, 96)
  print('two threads, the first open', rows)
  expect(ruled(rows[1])).toBe(true)
  expect(rows[2]).toMatch(/^ {3}main +2 threads$/)
  // the list: each thread its question alone while one is open; no line of an answer competes with the open thread's
  const first = rows.findIndex((r, i) => i > 2 && r.includes(`"${ASKED}"`))
  const second = rows.findIndex((r, i) => i > 2 && r.includes('"Which participant took longest?"'))
  expect(rows[first]!.startsWith(' ❯ ')).toBe(true)
  expect(Math.abs(second - first)).toBe(1)
  expect(rows.join('\n')).not.toContain('P3, at 48 minutes.')
  expect(rows.join('\n').split('Yes. The 7 screen recordings').length - 1).toBe(1)
  // then a rule, the open thread's `about` row, a blank row and its question on the prompt's background
  const rule = rows.findIndex((r, i) => i > Math.max(first, second) && ruled(r))
  expect(rule).toBe(Math.max(first, second) + 1)
  expect(rows[rule + 1]).toBe('   about "The files show 7 participants, P1 to P7. Each one has a…"')
  expect(rows[rule + 2]).toBe('')
  expect(rows[rule + 3]).toBe(` ❯ ${ASKED}`)
  await pane.unmount()
})

test("a thread's turns keep a rhythm: a blank row between a question and its answer, around a card and between turns", async ($, on) => {
  const w = world(on)
  sizeThread(w, [], [
    { type: 'user', text: 'And the logs, by participant?' },
    { type: 'text', delta: 'P6 has 120 MB of them and P7 54 MB.', reply: true },
    { type: 'done', result: 'P6 has 120 MB of them and P7 54 MB.' },
  ])
  await start($, w)
  const pane = await openedThread($, w, 'tz')
  const rows = await screen(pane, 96)
  print('a thread of two turns', rows)
  const bottom = rows.findIndex(r => /^ {3}╰─+╯$/.test(r))
  // the card's takeaway inside its border, then a blank row, then the next question and, after a blank row, its answer
  expect(rows[bottom + 1]).toBe('')
  expect(rows[bottom + 2]).toBe(' ❯ And the logs, by participant?')
  expect(rows[bottom + 3]).toBe('')
  expect(rows[bottom + 4]).toBe(' ⏺ P6 has 120 MB of them and P7 54 MB.')
  expect(JSON.stringify(await pane.find({ key: 'm:thread-q-2' }))).toContain(`"backgroundColor":"${COLORS.prompt}"`)
  await pane.unmount()
})

test("a side thread's turn at work as Claude Code draws one: a blank row, `⏺ ◌ N tool calls` dim, its latest words after `⎿`; `stop`, then the entry box", async ($, on) => {
  const w = world(on)
  sizeThread(w, [], [
    { type: 'user', text: 'And the logs, by participant?' },
    { type: 'tool_use', id: 'u2', name: 'Bash', input: {} },
    { type: 'tool_use', id: 'u3', name: 'Bash', input: {} },
    { type: 'text', delta: 'Reading the logs folder.\n\nCounting **by participant** now.' },
  ])
  Object.assign((w.chats.tz as { meta: Record<string, unknown> }).meta, { running: true })
  await start($, w)
  const pane = await openedThread($, w, 'tz')
  const rows = await screen(pane, 96)
  print('a thread at work', rows)
  const q = rows.indexOf(' ❯ And the logs, by participant?')
  expect(q).toBeGreaterThan(0)
  expect(rows.slice(q, q + 7)).toEqual([' ❯ And the logs, by participant?', '', ' ⏺ ◌ 2 tool calls', '   ⎿  Counting by participant now.', '', '   stop', rows[q + 6]])
  expect(boxRule(rows[q + 6])).toBe(true)
  expect(rows[q + 7]).toBe(' ❯ ask a follow-up question▏')
  const run = JSON.stringify(await pane.find({ key: 'm:thread-run-2' }))
  expect(run).toContain('"dimColor":true')
  await pane.unmount()
})

test("a side thread's turn that ended with no answer, as Claude Code says an interrupt or an error: a `⎿` row right under its question, dim for a stop, red with × for a failure", async ($, on) => {
  const w = world(on)
  sizeThread(w, [], [
    { type: 'user', text: 'And the logs?' },
    { type: 'error', kind: 'stopped', error: 'stopped by the analyst' },
    { type: 'user', text: 'By participant?' },
    { type: 'error', error: 'the fork ended: overloaded' },
  ])
  await start($, w)
  const pane = await openedThread($, w, 'tz')
  const rows = await screen(pane, 96)
  print('a thread stopped, then failed', rows)
  const q = rows.indexOf(' ❯ And the logs?')
  expect(q).toBeGreaterThan(0)
  expect(rows.slice(q, q + 5)).toEqual([' ❯ And the logs?', '   ⎿  stopped by the analyst.', '', ' ❯ By participant?', '   ⎿  × the fork ended: overloaded'])
  expect(boxRule(rows[q + 5])).toBe(true)
  const stopped = JSON.stringify(await pane.find({ key: 'thread-err-2' }))
  expect(stopped).toContain('"dimColor":true')
  expect(stopped).not.toContain('"color":"error"')
  expect(JSON.stringify(await pane.find({ key: 'thread-err-3' }))).toContain('{"type":"Text","props":{"wrap":"wrap","color":"error"},"children":["× the fork ended: overloaded"]}')
  await pane.unmount()
})

test("a side thread's question as Claude Code draws a prompt: its blank lines kept on the prompt's background, `❯` in the inactive color", async ($, on) => {
  const w = world(on)
  sizeThread(w, [], [
    { type: 'user', text: 'And the logs?\n\nBy participant, please.\n' },
    { type: 'text', delta: 'P6 has 120 MB of them.', reply: true },
    { type: 'done', result: 'P6 has 120 MB of them.' },
  ])
  await start($, w)
  const pane = await openedThread($, w, 'tz')
  const rows = await screen(pane, 96)
  const q = rows.indexOf(' ❯ And the logs?')
  expect(q).toBeGreaterThan(0)
  expect(rows.slice(q, q + 5)).toEqual([' ❯ And the logs?', '', '   By participant, please.', '', ' ⏺ P6 has 120 MB of them.'])
  const band = JSON.stringify(await pane.find({ key: 'm:thread-q-2' }))
  // three rows on the prompt's background, the blank one between the paragraphs too; none for the trailing newline
  expect(band.split(`"backgroundColor":"${COLORS.prompt}","wrap":"truncate-end"`).length - 1).toBe(3)
  expect(band).toContain(`"color":"${COLORS.dim}","backgroundColor":"${COLORS.prompt}"`)
  expect(band).not.toContain('"dimColor":true')
  await pane.unmount()
})
