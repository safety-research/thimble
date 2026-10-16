// The 0.9.0 terminal UI drawn as rows of text: the blank row Claude Code keeps above main's reply; a card's question
// wrapped, never cut, with its id; the citation panel as panel C, one bar whose parts open above it; a side thread's
// turn at work, a turn that ended with no answer, and its question as Claude Code draws a prompt.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { COLORS } from '../paint'
import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

// the test's own output: its drawings, for a reader
declare const console: { log: (...args: unknown[]) => void }

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

test("the person's message stays Claude Code's own row; the reply under it, or under the tool summary row, keeps the engine's blank row above it", { timeoutMs: 30_000 }, async ($, on) => {
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
  // so does an answer under Claude Code's tool summary row (`Ran 5 shell commands, called plugin:thimble:thimble 3
  // times`), which sat right under it in the v9 video (Matt, 2026-10-16)
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'And per wiki?', turnId: 't2' } as never)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u2' } as never)
  await append($, 'r2', 'Yes. Every number links to its source.')
  await $.turn.complete({ turnId: 't2', answer: 'Yes. Every number links to its source.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const after = (await $.ui.mount(MESSAGE('r2', 'Yes. Every number links to its source.'))) as unknown as M
  expect(((await after.drawn()) as Node).props).toMatchObject({ flexDirection: 'column', marginTop: 1 })
  expect((await screen(after, 100))[0]).toBe('⏺ Yes. Every number links to its source.')
  await after.unmount()
})

test("a card's question wraps, never cut, its id `card:<name>` dim at the right of its first row, the words its chip reads; a dot beside it the pointer turns into `?`", async ($, on) => {
  // Matt, 2026-10-16: a card's question was cut with "…"; a card citation should read `card:` and the card's name, and
  // "the card that it's referencing ... has the ID somewhere in the card itself"
  const w = world(on)
  const question = "How many records does each file hold, and how many of them are the agents' messages to each other?"
  Object.assign(w.cells.a0frame0!, { slug: 'records-per-file', title: question })
  w.resolve['card:a0frame0'] = { ref: 'card:a0frame0', kind: 'cell', cell_id: 'a0frame0', excerpt: question }
  await start($, w)
  const text = 'Most records are messages [[card:a0frame0]].'
  await turn($, w, 'r1', text, 'a0frame0')
  const ui = (await $.ui.mount({ plugin: PANEL, component: 'AssistantMessage', requestId: 'r1', surface: 'terminal', viewport: { columns: 60, rows: 40 }, props: { text, isFirstOfReply: true } } as never)) as unknown as M
  await w.clock.advance(300)
  const rows = await screen(ui, 60)
  print('a card with a long question, 60 columns', rows)
  // the chip in the reply and the id on the card read the same
  expect(rows[0]).toBe('⏺ Most records are messages [ card:records-per-file ].')
  // the card's own rows: its question wrapped at words, whole, the id against the right edge of the first row, then
  // one blank row
  const key = 'card-t0-a0frame0'
  const inner = Number(((await ui.find({ type: 'Client', key })) as Node).props?.width)
  await ui.resize({ columns: inner, rows: 40, in: key } as never)
  const own = (((await ui.drawn({ in: key })) as Node).children ?? []) as Node[]
  const lines = own.map(r => words(r))
  const blank = lines.findIndex(l => !l.trim())
  expect(blank).toBeGreaterThan(1)
  expect(lines[0]).toMatch(/^How many records does each +card:records-per-file$/)
  expect([...lines[0]!].length).toBe(inner)
  expect([lines[0]!.replace(/ +card:records-per-file$/, ''), ...lines.slice(1, blank)].join(' ')).toBe(question)
  expect(lines.join('\n')).not.toContain('…')
  expect(JSON.stringify(own[0])).toContain('{"type":"Text","props":{"color":"inactive"},"children":["card:records-per-file"]}')
  expect(JSON.stringify(own[0])).toContain('"bold":true')
  // beside the card's title, a dim dot; under the pointer its `?` (the card drawn at its width now)
  const framed = await screen(ui, 60)
  print('the same card drawn at its width', framed)
  const title = at(framed, 'How many records does each')
  expect(framed[title]).toMatch(/^· │ How many records does each +card:records-per-file │$/)
  expect(framed[title + 1]).toMatch(/^ {2}│ file hold, and how many of them are the agents' +│$/)
  expect((await screen(ui, 60, true))[title]).toMatch(/^\? │ How many records/)
  // the title's second row is the title too: in inverse under the pointer, and a press asks a side thread about the card
  await ui.pointer({ type: 'move', x: 2, y: 1, in: key } as never)
  const lit = (((await ui.drawn({ in: key })) as Node).children ?? []) as Node[]
  expect(JSON.stringify(lit[0])).toContain('"bold":true,"inverse":true')
  expect(JSON.stringify(lit[1])).toContain('"bold":true,"inverse":true')
  await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left', in: key } as never)
  await ui.pointer({ type: 'up', x: 2, y: 1, button: 'left', in: key } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = await look($)
  expect(shown(await pane.drawn())).toContain('New thread')
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ the citation panel

test("the citation panel as panel C: where the citation stands, its place as a link, its lines, then one bar above the entry box whose parts open above it", async ($, on) => {
  // MATT-NOTES "Mockup feedback" (mock3/citepanel2/panels.png): one bottom bar for the state and the history
  const w = world(on)
  Object.assign(w.cells.ff73e071!, {
    takeaway: 'The README says [[4,579|README.md#L3]] pages.',
    verification: { status: 'ok', links: { status: 'ok', checked: true, resolved: [], broken: [{ value: '4,579', ref: 'README.md#L3', why: 'the line says 4,579', source: '4,579', was: '4,580', corrected: true }] } },
  })
  await start($, w)
  await turn($, w, 'r1', 'Here.')
  let ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  // `The README says 4,579 pages.`: the value at column 16
  await ui.pointer({ type: 'down', x: 17, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.pointer({ type: 'up', x: 17, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  let pane = await look($, 96, 30)
  let rows = (await screen(pane, 96)).map(r => r.trim())
  print('the citation panel at rest', rows)
  const title = rows.findIndex(r => r.startsWith('home › citation 4,579'))
  expect(rows[title + 1]).toMatch(/^─+$/)
  expect(rows[title + 2]).toBe('from the card  What does the export hold per wiki?')
  expect(rows[title + 3]).toBe('')
  expect(rows[title + 4]).toBe('↗ README.md line 3')
  expect(rows[title + 5]).toBe('')
  // the lines, then a blank row, the dotted rule and the bar; a blank row, then the entry box
  const bar = at(rows, 'checked ›')
  expect(rows[bar]).toBe('checked ›   history 1 ›')
  expect(rows[bar - 1]).toMatch(/^┄+$/)
  expect(rows[bar - 2]).toBe('')
  expect(rows.slice(title + 6, bar - 2).join('\n')).toContain('3  An export of 4,579 wiki pages and their revisions.')
  expect(rows[bar + 1]).toBe('')
  expect(rows[bar + 2]).toMatch(/^─+$/)
  expect(rows[bar + 3]).toMatch(/^❯ Ask about this citation/)
  await pane.press({ key: 'cite-history' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($, 96, 30)
  rows = (await screen(pane, 96)).map(r => r.trim())
  print('history pressed', rows)
  const bar2 = at(rows, 'checked ›')
  expect(rows[bar2]).toBe('checked ›   history 1 ⌄')
  // above the bar after a blank row: what Claude wrote, what the check made it and why, then a blank row and the rule
  expect(rows[bar2 - 1]).toMatch(/^┄+$/)
  expect(rows.slice(bar2 - 5, bar2 - 1)).toEqual(['', 'Claude wrote 4,580', 'the check made it 4,579 · the line says 4,579', ''])
  // the state word opens how it was verified in its place: one part at a time
  await pane.press({ key: 'cite-state' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($, 96, 30)
  rows = (await screen(pane, 96)).map(r => r.trim())
  print('checked pressed', rows)
  const bar3 = at(rows, 'checked ⌄')
  expect(rows[bar3]).toBe('checked ⌄   history 1 ›')
  expect(rows.join('\n')).not.toContain('Claude wrote')
  const how = at(rows, 'thimble read the cited line')
  expect(rows.slice(how, bar3 - 3).join(' ')).toBe("thimble read the cited line and found the value there, and its card's links check found the same value; no script recomputed it")
  expect(rows[how - 1]).toBe('')
  // `ask for a script` on its own row under the words, then a blank row above the dotted rule
  expect(rows[bar3 - 3]).toBe('ask for a script')
  expect(rows[bar3 - 2]).toBe('')
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

// an entry box's rule: from the margin's edge, as Claude Code's prompt box spans its column
const boxRule = (r: string | undefined) => /^ ─+$/.test(r ?? '')

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
  // `stop`, a blank row, then the entry box (one row tall)
  expect(rows.slice(q, q + 8)).toEqual([' ❯ And the logs, by participant?', '', ' ⏺ ◌ 2 tool calls', '   ⎿  Counting by participant now.', '', '   stop', '', rows[q + 7]])
  expect(boxRule(rows[q + 7])).toBe(true)
  expect(rows[q + 8]).toBe(' ❯ Ask a follow-up question▏')
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
  expect(rows.slice(q, q + 6)).toEqual([' ❯ And the logs?', '   ⎿  stopped by the analyst.', '', ' ❯ By participant?', '   ⎿  × the fork ended: overloaded', ''])
  expect(boxRule(rows[q + 6])).toBe(true)
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
