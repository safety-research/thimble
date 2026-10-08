// The report in terminal mode (hooks/report.ts, panel.tsx drawDoc and drawDocEdit, hooks/docedit.tsx): a written
// document read as Markdown with its cards in their frames, its comments (a check's, Claude's note, the analyst's) under
// the passages they are on, ↑↓ to choose one, r to resolve it or open it again, Enter or a to ask about it, v to show the
// resolved ones; `e` edits the report as Markdown, and a save goes through the browser editor's route with the ids of the
// blocks the edit kept. Each panel is also drawn as rows of text (`screen`), as a terminal shows it.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { RELAY } from '../hooks/panel'
import { alignBlocks, checksOf, commentsOf, docBlocks, docMarkdown, parseMarkdown, unitParts } from '../hooks/report'
import type { DocBlock } from '../hooks/report'
import { editTop, editWindow } from '../hooks/docedit'
import { CWD, DOC, SLIDES, STATES, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const PANEL = 'thimble-term'
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
    ['tag:x3', 'Unverified', 'citation check', true],
  ])
  // a section's parts end at each passage with comments, which stand under it; a section with none is one part
  expect(unitParts(COMMENTED.sections[1] as never).length).toBe(1)
  const p2 = unitParts(COMMENTED.sections[0] as never, all)
  expect(p2.length).toBe(2)
  expect(p2[0]!.md).toBe('## The data\n\nThe corpus is an export of four wikis [[README.md#L3]]. It holds [[4579|card:ff73e071#pages/TOTAL]] pages.')
  expect(p2[0]!.after.map(c => c.id)).toEqual(['c4', 'c1'])
  expect(p2[1]!.md).toBe('[[card:ff73e071]]\n*The export per wiki.*')
})

test('a report as Markdown and back: headings, lists, figures as their card\'s line, citations as written; the title apart', () => {
  const doc = {
    title: 'Agents used the dse wiki',
    sections: [
      { id: 's1', heading: 'The data', paragraphs: [{ id: 'p1', sentences: [{ id: 'x1', text: 'It holds [[4579|card:ff73e071#pages/TOTAL]] pages.' }] }], figures: [{ id: 'f1', cell: 'card:ff73e071', caption: 'Pages per wiki.', after_paragraph: 'p1' }] },
      { id: 's2', heading: 'Caveats', level: 3, paragraphs: [{ id: 'p2', sentences: [{ id: 'b1', text: 'One week only.', bullet: '-' }, { id: 'b2', text: 'No deletions.', bullet: '-' }] }], figures: [] },
    ],
  }
  const blocks = docBlocks(doc)
  const md = docMarkdown(doc.title, blocks)
  expect(md).toBe('# Agents used the dse wiki\n\n## The data\n\nIt holds [[4579|card:ff73e071#pages/TOTAL]] pages.\n\n![Pages per wiki.](card:ff73e071)\n\n### Caveats\n\n- One week only.\n- No deletions.\n')
  const back = parseMarkdown(md)
  expect(back.title).toBe('Agents used the dse wiki')
  expect(alignBlocks(blocks, back.blocks)).toEqual(blocks)
  // a chip alone on its line is a figure too, an italic line under it its caption; `1.` a numbered item
  expect(parseMarkdown('## A\n\n[[card:abc12345]]\n*Its caption.*\n\n1. first\n   more of it\n2. second\n').blocks).toEqual([
    { id: '', type: 'heading', text: 'A', level: 2 },
    { id: '', type: 'figure', cell: 'card:abc12345', caption: 'Its caption.' },
    { id: '', type: 'bullet', text: 'first more of it', marker: '1.' },
    { id: '', type: 'bullet', text: 'second', marker: '1.' },
  ])
})

test('an edited block keeps the id of the block it was built from: kept words, then changed ones in their place, new ones none', () => {
  const before: DocBlock[] = [
    { id: 's1', type: 'heading', text: 'The data', level: 2 },
    { id: 'p1', type: 'paragraph', text: 'One. Two.' },
    { id: 'f1', type: 'figure', cell: 'card:ff73e071', caption: 'Pages.' },
    { id: 's2', type: 'heading', text: 'Caveats', level: 2 },
    { id: 'p2', type: 'paragraph', text: 'Only a week.' },
  ]
  const after = parseMarkdown('# T\n\n## The data at a glance\n\nOne. Two, and three.\n\nA new paragraph.\n\n![Pages.](card:ff73e071)\n\n## Caveats\n\nOnly a week.\n\n## Next\n').blocks
  expect(alignBlocks(before, after).map(b => b.id)).toEqual(['s1', 'p1', '', 'f1', 's2', 'p2', ''])
  // blocks moved past each other: the longest run in order keeps its ids, each id taken once (the save keeps a moved
  // sentence's record by its words, backend apply_blocks)
  const moved = alignBlocks(before, parseMarkdown('## Caveats\n\nOnly a week.\n\n## The data\n\n![Pages.](card:ff73e071)\n').blocks).map(b => b.id)
  expect(moved.filter(Boolean).length).toBe(2)
  expect(new Set(moved.filter(Boolean)).size).toBe(2)
})

test("the editor's window keeps the cursor in view, a row each for `↑ N more` and `↓ N more`", () => {
  expect(editWindow(0, 5, 10)).toEqual({ up: 0, down: 0, n: 5 })
  expect(editWindow(0, 50, 10)).toEqual({ up: 0, down: 1, n: 9 })
  expect(editWindow(20, 50, 10)).toEqual({ up: 1, down: 1, n: 8 })
  expect(editWindow(42, 50, 10)).toEqual({ up: 1, down: 0, n: 9 })
  expect(editTop(0, 9, 50, 10)).toBe(2)
  expect(editTop(20, 5, 50, 10)).toBe(5)
  expect(editTop(5, 49, 50, 10)).toBe(41)
})

// ------------------------------------------------------------------------------------------------ the panel

test('comments stand under the passages they are on: the check\'s name and hue, what it is at the right; a note dim; the title\'s under the header', async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  await start($, w)
  await openReport($, w)
  const pane = await look($)
  const rows = await screen(pane)
  // the subtitle, under the title row, counts them; the resolved one and the check that is off are not shown
  expect(rows[1]).toBe('   4 open comments · 1 resolved')
  expect(rows.join('\n')).not.toContain('Found on the card.')
  expect(rows.join('\n')).not.toContain('README.md line 3 says four wikis.')
  // the title's comment right under the header's rule
  expect(rows[2]!.trim()).toMatch(/^─+$/)
  expect(rows[3]).toMatch(/^ {5}● Judgment calls +check$/)
  expect(rows[4]).toBe('       The title claims a relay; the report shows saves, not messages passed on.')
  // the check's comment under its sentence's paragraph, before the paragraph's card
  const para = rowOf(rows, 'The corpus is an export of four wikis')
  const c1 = rowOf(rows, 'The card counts 4,579 pages')
  expect(rows[c1 - 1]).toMatch(/^ {5}● Judgment calls +check$/)
  expect(c1).toBe(para + 2)
  expect(rows.findIndex((r, i) => i > c1 && /╭─+╮/.test(r))).toBe(c1 + 2)
  expect(rows[c1 + 1]).toBe('       one wiki.')
  // Claude's note under the heading it is on, then a blank row before the words under the heading
  const head = rowOf(rows, 'The main claim')
  expect(rows[head + 1]).toMatch(/^ {5}● Claude +comment$/)
  expect(rows[head + 2]).toBe('       Say which week of June.')
  expect(rows[head + 3]).toBe('')
  // the citation check's tag under its sentence
  expect(rows[rowOf(rows, 'No card counts saves by week.') - 1]).toMatch(/^ {5}● Unverified +citation check$/)
  // the hues: the check's on its ●, a note's dim, every name in the text color
  const block = (await pane.drawn({ in: 'm:doc-cm-0-0' })) as Node
  const marks = JSON.stringify(block)
  expect(marks).toContain('"color":"#b96895"},"children":["●"]')
  expect(JSON.stringify(await pane.drawn({ in: 'm:doc-cm-1-0' }))).toContain('"color":"inactive"},"children":["●"]')
  await pane.unmount()
})

test('↑↓ choose a comment (`❯`, the accent), its chips under it; r resolves it as the margin\'s ✓ does and the choice moves on; v shows the resolved ones', async ($, on) => {
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
  expect(rows.join('\n')).toContain('resolve  ask about it')
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

test('Enter or a asks a side thread about the chosen comment, on its passage, told the passage and the comment', async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  await start($, w)
  await openReport($, w)
  await takesKeys($)
  await w.clock.advance(300)
  await arrow($, w, 'down', 2)
  await hotkey($, w, 'cm-ask')
  const asked = await look($)
  await asked.input({ key: 'ask-new', text: 'Fix the sentence.' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({
    anchor: 'report:report#x2',
    anchor_text: 'It holds 4579 pages.\n\nThe comment of the check “Judgment calls”: The card counts 4,579 pages across all four wikis; say so, since the sentence reads as one wiki.',
    element: 'report:report#x2',
    message: 'Fix the sentence.',
  })
  await asked.unmount()
})

test('in a deck, ↓ onto a comment on another slide steps to that slide', async ($, on) => {
  const w = world(on)
  w.docs.slides = { ...SLIDES, comments: [{ id: 'k1', sentence_id: 'y3', text: 'Which week?', check: 'judgment', status: 'open' }] }
  w.states.docs = { ...w.states.docs, slides: { exists: true, title: SLIDES.title, renderer: 'slides', name: 'Slides' } } as never
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  let pane = await look($)
  const open = ((await pane.findAll({ type: 'Button' })) as { key?: string; props?: { label?: string } }[]).find(b => b.props?.label === SLIDES.title)!
  await pane.press({ key: open.key! })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  expect((await screen(pane)).join('\n')).toContain('1 of 2')
  await pane.unmount()
  await takesKeys($)
  await w.clock.advance(300)
  await arrow($, w, 'down')
  pane = await look($)
  const rows = await screen(pane)
  expect(rows.join('\n')).toContain('2 of 2')
  expect(rows[rowOf(rows, 'Which week?') - 1]).toMatch(/❯ {3}● Judgment calls +check$/)
  await pane.unmount()
})

test('while a check runs on the document its subtitle says so', async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  w.states.checks = w.states.checks.map(c => (c.id === 'judgment' ? { ...c, runs: { report: { status: 'running' } } } : c))
  await start($, w)
  await openReport($, w)
  const pane = await look($)
  expect((await screen(pane))[1]).toBe('   4 open comments · 1 resolved · ◌ Judgment calls checking')
  await pane.unmount()
})

const EDITED = '# Agents used the dse wiki as a relay\n\n## The data\n\nThe corpus is an export of four wikis [[README.md#L3]]. It holds [[4579|card:ff73e071#pages/TOTAL]] pages in all four.\n\n![The export per wiki.](card:ff73e071)\n\n## The main claim\n\nOne week of June holds most saves.\n\n## What it leaves open\n\nWhy June.\n'

test('e edits the report as Markdown, its cards as their lines; a save sends the blocks with the ids they were built from, then shows the report', async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  await start($, w)
  await openReport($, w)
  await hotkey($, w, 'edit')
  let pane = await look($)
  let rows = await screen(pane)
  expect(rows[0]).toMatch(/home › documents › "Agents used the dse wiki[^"]*" · edit$/)
  expect(rows[1]).toBe('   editing as Markdown · a card is its line ![caption](card:<id>)')
  const editor = rowOf(rows, '# Agents used the dse wiki as a relay')
  expect(rows[editor - 1]).toMatch(/^ {3}╭─+╮$/)
  expect(rows.slice(editor, editor + 9).map(r => r.replace(/^ {3}│ /, '').replace(/ *│$/, ''))).toEqual([
    '# Agents used the dse wiki as a relay',
    '',
    '## The data',
    '',
    'The corpus is an export of four wikis [[README.md#L3]]. It holds',
    '[[4579|card:ff73e071#pages/TOTAL]] pages.',
    '',
    '![The export per wiki.](card:ff73e071)',
    '',
  ])
  expect(shown(await pane.find({ key: 'h-hints' }))).toBe('ctrl+s or s to save · b to go back · x to close')
  // what the editor holds once typed: its post, as docedit.tsx sends each change
  await pane.post({ type: 'doc-edit', slug: 'report', text: EDITED, save: false }, { in: 'doc-editor-report' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = await look($)
  rows = await screen(pane)
  expect(rows[1]).toContain('unsaved edits')
  expect(shown(await pane.find({ key: 'h-hints' }))).toBe('ctrl+s or s to save · d to discard · b to go back · x to close')
  await pane.unmount()
  await hotkey($, w, 'save')
  const save = w.acts.find(a => a.kind === 'doc-save')!
  expect(save.payload.doc).toBe('report')
  expect(save.payload.title).toBe('Agents used the dse wiki as a relay')
  expect((save.payload.blocks as DocBlock[]).map(b => [b.id, b.type])).toEqual([
    ['s1', 'heading'],
    ['p1', 'paragraph'],
    ['f1', 'figure'],
    ['s2', 'heading'],
    ['p2', 'paragraph'],
    ['', 'heading'],
    ['', 'paragraph'],
  ])
  expect((save.payload.blocks as DocBlock[])[1]!.text).toContain('pages in all four.')
  // saved, the panel shows the report again
  await w.clock.settle()
  pane = await look($)
  rows = await screen(pane)
  expect(rows[0]).toMatch(/home › documents › "Agents used the dse wiki[^"]*"$/)
  expect(rows.join('\n')).toContain('e to edit')
  await pane.unmount()
})

test('the editor takes the keys after a click: typing goes in at the cursor, Enter breaks the line, ctrl+s saves', async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  await start($, w)
  await openReport($, w)
  await hotkey($, w, 'edit')
  const pane = await look($)
  // a click on the title's row after `# `, then a word typed there and a line broken after it
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'doc-editor-report' } as never)
  await pane.key({ key: 'Our ', in: 'doc-editor-report' } as never)
  await pane.key({ key: 'end', in: 'doc-editor-report' } as never)
  await pane.key({ key: 'return', in: 'doc-editor-report' } as never)
  await pane.key({ key: 'backspace', in: 'doc-editor-report' } as never)
  const drawn = shown(await pane.drawn({ in: 'doc-editor-report' }))
  expect(drawn).toContain('# Our Agents used the dse wiki as a relay')
  await pane.key({ key: 's', ctrl: true, in: 'doc-editor-report' } as never)
  await w.clock.settle()
  await pane.unmount()
  const save = w.acts.find(a => a.kind === 'doc-save')!
  expect(save.payload.title).toBe('Our Agents used the dse wiki as a relay')
  expect((save.payload.blocks as DocBlock[]).map(b => b.id)).toEqual(['s1', 'p1', 'f1', 's2', 'p2'])
})

test('a save after the document changed meanwhile stops and says so; s again saves over it, d discards the edit', async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  await start($, w)
  await openReport($, w)
  await hotkey($, w, 'edit')
  let pane = await look($)
  await pane.post({ type: 'doc-edit', slug: 'report', text: EDITED, save: false }, { in: 'doc-editor-report' } as never)
  await w.clock.settle()
  await pane.unmount()
  // the writer saved the report meanwhile
  w.docs.report = { ...COMMENTED, title: 'A newer title' }
  await hotkey($, w, 'save')
  expect(w.acts.some(a => a.kind === 'doc-save')).toBe(false)
  pane = await look($)
  let rows = await screen(pane)
  expect(rows.join(' ')).toContain('! the document changed since you began editing it: s again saves yours over it')
  await pane.unmount()
  await hotkey($, w, 'discard')
  pane = await look($)
  rows = await screen(pane)
  expect(rows.join('\n')).not.toContain('unsaved edits')
  expect(rows.join('\n')).toContain('# A newer title')
  await pane.unmount()
})

test('the report with its comments at 120 columns, a comment chosen, and its edit, as rows of text', async ($, on) => {
  const w = world(on)
  w.docs.report = COMMENTED
  await start($, w)
  await openReport($, w, 116, 70)
  await takesKeys($)
  await w.clock.advance(300)
  let pane = await look($, 116, 70)
  const read = await screen(pane, 116)
  await pane.unmount()
  await arrow($, w, 'down', 2)
  pane = await look($, 116, 70)
  const chosen = await screen(pane, 116)
  await pane.unmount()
  await hotkey($, w, 'edit')
  pane = await look($, 116, 30)
  const edit = await screen(pane, 116)
  await pane.unmount()
  // every row within the pane's 120 columns; the type area's edge, A0, at column 3 after the pane's padding and the
  // margin; the chosen comment's `❯` in the margin; the editor's border as wide as the rules
  for (const rows of [read, chosen, edit]) expect(rows.every(r => wide(r) <= 120)).toBe(true)
  // one title row: the path, the document last in the accent and bold
  expect(read[0]).toBe('   home › documents › "Agents used the dse wiki as a relay"')
  expect(chosen.filter(r => r.startsWith(' ❯'))).toEqual([expect.stringMatching(/^ ❯ {3}● Judgment calls {80,}check$/)])
  const rule = edit.find(r => /^ {3}─+$/.test(r))!
  expect(edit.find(r => /^ {3}╭─+╮$/.test(r))!.length).toBe(rule.length)
})
