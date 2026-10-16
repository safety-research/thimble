// The report in the terminal, read only (report.ts, panel.tsx drawDoc): the comments a document shows, in reading order
// with a check that is off left out; ↑↓ to choose one, r to resolve it or open it again (`thimble act comment-resolve`,
// `comment-reopen`), v to show the resolved ones. The panel is read as rows of text (`screen`), as a terminal shows it.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { RELAY } from '../panel'
import { checksOf, commentsOf, unitParts } from '../report'
import { CWD, DOC, STATES, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const PANEL = 'thimble'
const paneOf = (cols = 96, rows = 60) => ({ plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns: cols + 24, rows: rows + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { bodyRows: rows }, view: {} } }) as never

// a report with a check's comment on a sentence, Claude's note on a heading, a check's comment on the title, a resolved
// one, one of a check that is off (Verified), and the citation check's tag on a sentence
const COMMENTED = {
  ...DOC,
  sections: [DOC.sections[0], { ...DOC.sections[1], paragraphs: [{ id: 'p2', sentences: [{ id: 'x3', text: 'One week of June holds most saves.', tags: ['unverified'], tag_notes: { unverified: 'No card counts saves by week.' } }] }] }],
  comments: [
    { id: 'c1', sentence_id: 'x2', text: 'The card counts 4,579 pages across all four wikis; say so, since the sentence reads as one wiki.', check: 'judgment', status: 'open', evidence: 'card:ff73e071#pages/TOTAL' },
    { id: 'c2', sentence_id: 's2', text: 'Say which week of June.', author: 'claude', status: 'open' },
    { id: 'c3', sentence_id: 'title', text: 'The title claims a relay; the report shows saves, not messages passed on.', check: 'judgment', status: 'open' },
    { id: 'c4', sentence_id: 'x1', text: 'README.md line 3 says four wikis.', check: 'judgment', status: 'dismissed' },
    { id: 'c5', sentence_id: 'x1', text: 'Found on the card.', check: 'verified', status: 'open' },
  ],
}

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function look($: E, cols = 96, rows = 60): Promise<M> {
  return (await $.ui.mount(paneOf(cols, rows))) as unknown as M
}

/** The report opened from the documents list, its cards read. */
async function openReport($: E, w: World, cols = 96, rows = 60): Promise<void> {
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  const pane = await look($, cols, rows)
  await pane.press({ key: 'doc-open-0' })
  await w.clock.settle()
  await pane.unmount()
  await w.clock.advance(1100)
}

async function ring($: E, element: string): Promise<unknown> {
  return $.ui.focus({ requestId: PANEL, component: 'Pane', element, origin: { kind: 'person' } } as never)
}

/** ↓ or ↑ through the relay, the panel drawn first so the key acts on what it shows. */
async function arrow($: E, w: World, key: 'down' | 'up', n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await (await look($)).unmount()
    expect(await ring($, key === 'down' ? RELAY.down : RELAY.up)).toEqual({})
    await w.clock.settle()
  }
}

async function hotkey($: E, w: World, key: string): Promise<void> {
  const pane = await look($)
  await pane.press({ key: `hk-${key}` })
  await w.clock.settle()
  await pane.unmount()
}

// ------------------------------------------------------------------------------------------------ the panel as text

/** The words of a Text and its nested Texts. */
function words(n: unknown): string {
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(words).join('')
  if (n && typeof n === 'object') {
    const o = n as Node
    return words(o.children ?? o.props?.children)
  }
  return ''
}

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

/** A drawn tree laid out in `w` columns as a terminal shows it, near enough for a reader: Boxes stack or sit side by
 *  side, with their padding, margins, gaps and round borders; a Text wraps or is cut; Markdown drops its marks; a
 *  Client is what its module drew (`clients`, by key); a Box no row tall (the hotkeys, the relay) shows nothing. */
function layout(n: unknown, w: number, clients: Map<string, unknown>): string[] {
  if (typeof n === 'string') return wrap(n, w)
  if (Array.isArray(n)) return n.flatMap(k => layout(k, w, clients))
  if (!n || typeof n !== 'object') return []
  const o = n as Node
  const p = o.props ?? {}
  if (p.display === 'none' || p.width === 0 || p.height === 0) return []
  if (o.type === 'Client') return layout(clients.get(String(p.key)), typeof p.width === 'number' ? Math.min(w, p.width) : w, clients)
  if (o.type === 'Button') return [String(p.label ?? '')]
  if (o.type === 'Input') return []
  if (o.type === 'Markdown') return wrap(String(p.text ?? '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)\*([^*]+)\*/g, '$1$2'), w)
  if (o.type === 'Text') {
    const s = words(o)
    return p.wrap === 'wrap' ? wrap(s, w) : s.split('\n').map(l => (wide(l) > w ? fit(l, w) : l))
  }
  const kids = (o.children ?? (p.children as unknown[] | undefined) ?? []) as unknown[]
  const border = p.borderStyle ? 2 : 0
  const padL = Number(p.paddingLeft ?? p.paddingX ?? 0)
  const padR = Number(p.paddingRight ?? p.paddingX ?? 0)
  const outer = typeof p.width === 'number' ? Math.min(w, p.width) : w
  const inner = Math.max(1, outer - border - padL - padR)
  let rows: string[]
  if (p.flexDirection === 'row') {
    const gap = Number(p.columnGap ?? 0)
    const parts = kids.filter(k => k !== null && k !== undefined && k !== false)
    const fixed = parts.map(k => ((k as Node)?.props?.width as number | undefined) ?? null)
    const grow = parts.map(k => (k as Node)?.props?.flexGrow === 1 && !((k as Node).children ?? []).length)
    let left = inner - gap * Math.max(0, parts.length - 1)
    const drawn: (string[] | null)[] = parts.map((k, i) => {
      if (grow[i]) return null
      const lines = layout(k, fixed[i] ?? Math.max(1, left), clients)
      const used = fixed[i] ?? Math.max(0, ...lines.map(wide))
      left -= used
      return lines
    })
    const widths = drawn.map((d, i) => (d === null ? Math.max(0, left) : fixed[i] ?? Math.max(0, ...d.map(wide))))
    const height = Math.max(1, ...drawn.map(d => d?.length ?? 0))
    rows = Array.from({ length: height }, (_, y) => drawn.map((d, i) => fit(d?.[y] ?? '', widths[i]!)).join(' '.repeat(gap)).replace(/\s+$/, ''))
    if (drawn.every(d => d !== null && !d.length)) rows = []
  } else {
    rows = []
    for (const k of kids) {
      const top = Number((k as Node)?.props?.marginTop ?? 0)
      const lines = layout(k, inner, clients)
      if (lines.length || top) rows.push(...Array.from({ length: top }, () => ''), ...lines)
    }
  }
  rows = rows.map(r => ' '.repeat(padL) + r)
  if (border) rows = [`╭${'─'.repeat(outer - 2)}╮`, ...rows.map(r => `│${fit(r, outer - 2)}│`), `╰${'─'.repeat(outer - 2)}╯`]
  return rows
}

/** The panel as rows of text, `cols` wide as the pane draws its body (its padding, then the margin, then the type
 *  area): every Client's drawing read first. */
async function screen(pane: M, cols = 96): Promise<string[]> {
  const tree = await pane.drawn()
  const keys = [...JSON.stringify(tree).matchAll(/"type":"Client","props":\{"key":"([^"]+)"/g)].map(m => m[1]!)
  const clients = new Map<string, unknown>()
  const widths = new Map([...JSON.stringify(tree).matchAll(/"type":"Client","props":\{"key":"([^"]+)"[^}]*?"width":(\d+)/g)].map(m => [m[1]!, Number(m[2])]))
  for (const k of keys) {
    // a Client draws at the width the panel lays it out at, as in a terminal
    if (widths.get(k)) await pane.resize({ columns: widths.get(k)!, rows: 60, in: k } as never).catch(() => undefined)
    clients.set(k, await pane.drawn({ in: k }))
  }
  return layout(tree, cols, clients).map(r => r.replace(/\s+$/, ''))
}

const rowOf = (rows: string[], text: string) => rows.findIndex(r => r.includes(text))

// ------------------------------------------------------------------------------------------------ pure

test('the comments a document shows: in reading order, a check that is off left out, the citation check\'s tag, the resolved ones apart', () => {
  const checks = checksOf(STATES.checks)
  const all = commentsOf(COMMENTED as never, checks)
  expect(all.map(c => [c.id, c.name, c.meta, c.open])).toEqual([
    ['c3', 'Judgment calls', 'check', true],
    ['c4', 'Judgment calls', 'check', false],
    ['c1', 'Judgment calls', 'check', true],
    ['c2', 'Claude', 'comment', true],
    ['tag:x3', 'Unverifiable', 'citation check', true],
  ])
  // a section's parts end at each passage with comments, which stand under it; a section with none is one part
  expect(unitParts(COMMENTED.sections[1] as never).length).toBe(1)
  const p2 = unitParts(COMMENTED.sections[0] as never, all)
  expect(p2.length).toBe(2)
  expect(p2[0]!.md).toBe('## The data\n\nThe corpus is an export of four wikis [[README.md#L3]]. It holds [[4579|card:ff73e071#pages/TOTAL]] pages.')
  expect(p2[0]!.after.map(c => c.id)).toEqual(['c4', 'c1'])
  expect(p2[1]!.md).toBe('[[card:ff73e071]]\n*The export per wiki.*')
})

// ------------------------------------------------------------------------------------------------ the panel

test('↑↓ choose a comment (`❯`, the accent), its chips under it; r resolves it as the margin\'s ✓ does and the choice moves on; v shows the resolved ones', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  await start($, w)
  await openReport($, w)
  await takesKeys($)
  await w.clock.advance(300)
  let pane = await look($)
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('↑↓ to choose a comment')
  await pane.unmount()
  await arrow($, w, 'down', 2)
  // (the chosen comment's block is scrolled into view with $.ui.scroll, which the test kit leaves unanswered for a
  // plugin's own call)
  pane = await look($)
  await w.clock.advance(100)
  let rows = await screen(pane)
  const chosen = rows.findIndex(r => r.startsWith(' ❯'))
  expect(rows[chosen]).toMatch(/^ ❯ {3}● Judgment calls +check$/)
  expect(rows[chosen + 1]).toContain('The card counts 4,579 pages')
  // its refs as chips under its words
  expect(rows[chosen + 3]).toBe('       [ card ]')
  expect(rows[chosen + 2]).toBe('       one wiki.')
  expect(JSON.stringify(await pane.drawn({ in: 'm:doc-cm-0-0' }))).toContain('"color":"suggestion"},"children":[" Judgment calls')
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('↑↓ to choose a comment · Enter or a to ask · r to resolve')
  // the chosen comment's entry box under the acts: `❯` in the margin between two rules, no `ask about it`
  expect(rows.join('\n')).not.toContain('ask about it')
  // (this layout draws no Input: the box's row shows its `❯` alone)
  const box = rows.findIndex(r => r === ' ❯')
  expect(box).toBeGreaterThan(chosen)
  expect(rows[box - 1]).toMatch(/^ ─+$/)
  expect(rows[box + 1]).toMatch(/^ ─+$/)
  expect(rows[box - 2]).toMatch(/^ {3}resolve {2}/)
  await pane.unmount()
  await hotkey($, w, 'resolve')
  expect(w.acts.at(-1)).toEqual({ kind: 'comment-resolve', payload: { doc: 'report', comment: 'c1' } })
  // thimble resolved it; the next comment is chosen
  w.docs.report = { ...COMMENTED, comments: COMMENTED.comments.map(c => (c.id === 'c1' ? { ...c, status: 'dismissed' } : c)) }
  w.stamps.set('/home/a/.thimble/app/workspaces/wiki/investigations/main/report.json', 2)
  await w.clock.advance(1100)
  pane = await look($)
  rows = await screen(pane)
  expect(rows[1]).toBe('   3 open comments · 2 resolved')
  expect(rows.join('\n')).not.toContain('The card counts 4,579 pages')
  expect(rows[rows.findIndex(r => r.startsWith(' ❯'))]).toMatch(/● Claude +comment$/)
  await pane.unmount()
  // v shows the resolved ones, dim, `resolved` after what each is; r on one opens it again
  await hotkey($, w, 'cm-resolved')
  pane = await look($)
  rows = await screen(pane)
  expect(rows[rowOf(rows, 'The card counts 4,579 pages') - 1]).toMatch(/● Judgment calls +check · resolved$/)
  expect(rows.join('\n')).toContain('hide resolved')
  await pane.unmount()
  await arrow($, w, 'up', 1)
  await hotkey($, w, 'resolve')
  expect(w.acts.at(-1)).toEqual({ kind: 'comment-reopen', payload: { doc: 'report', comment: 'c1' } })
})
