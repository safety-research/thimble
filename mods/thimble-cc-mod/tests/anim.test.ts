// Animation frames for playing a card (hooks/anim.ts). `claude plugin test mods/thimble-cc-mod`.
import { expect, test } from 'claude-code/testing'

import { animFrame, focusFromRef, focusItem } from '../hooks/anim'
import { cardLayout, lineWidth } from '../hooks/draw'
import type { CardData, Line } from '../hooks/draw'
import { COLORS } from '../hooks/paint'

const base = { question: 'q', x: '', y: '', note: '', source: {} }
const LINE: CardData = {
  ...base,
  id: 'l1',
  kind: 'line',
  x: 'day',
  y: 'saves',
  series: [
    { name: 'saves', points: [['2026-06-15', 1200], ['2026-06-16', 2400], ['2026-06-17', 3100], ['2026-06-18', 6543], ['2026-06-19', 2800], ['2026-06-20', 900]] },
    { name: 'reverts', points: [['2026-06-15', 100], ['2026-06-16', 300], ['2026-06-17', 800], ['2026-06-18', 1900], ['2026-06-19', 700], ['2026-06-20', 200]] },
  ],
}
const BAR: CardData = {
  ...base,
  id: 'b1',
  kind: 'bar',
  y: 'revisions',
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
    { label: 'sandbox', value: 2.5, group: '' },
  ],
  total: 14418.5,
}
const TIMELINE: CardData = {
  ...base,
  id: 't1',
  kind: 'timeline',
  events: [
    { time: '2026-06-18T17:15:00Z', label: 'First revision', ref: '' },
    { time: '2026-06-18T19:02:00Z', label: 'The bot starts reverting edits on the main page', ref: 'revisions.jsonl#L4' },
    { time: '2026-06-18T21:26:00Z', label: 'Last revert', ref: 'revisions.jsonl#L9' },
  ],
}
const TABLE: CardData = {
  ...base,
  id: 'tb1',
  kind: 'table',
  columns: ['agent', 'edits', 'reverts'],
  rows: [
    ['alpha', 120, 4],
    ['beta', 87, 19],
    ['gamma', 33, 0],
    ['delta', 9, 1],
  ],
}
const EXAMPLE: CardData = {
  ...base,
  id: 'e1',
  kind: 'example',
  examples: [
    { ref: 'chat.jsonl#L12', quote: 'I will revert every edit that touches the main page until someone stops me.', note: 'announces the reverts' },
    { ref: 'chat.jsonl#L40', quote: 'Fine, I stop now.', note: 'gives up' },
  ],
}
const DIAGRAM: CardData = {
  ...base,
  id: 'd1',
  kind: 'diagram',
  nodes: [
    { id: 'p', label: 'Planner' },
    { id: 'c', label: 'Coder' },
    { id: 'r', label: 'Reviewer' },
    { id: 'm', label: 'Merger' },
  ],
  edges: [
    { source: 'p', target: 'c', label: 'assigns' },
    { source: 'c', target: 'r', label: 'opens a pull request' },
    { source: 'r', target: 'm', label: 'approves' },
  ],
}
const CARDS = [LINE, BAR, TIMELINE, TABLE, EXAMPLE, DIAGRAM]
const TS = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1]

const text = (lines: Line[]) => lines.map(l => l.map(s => s.s).join(''))
const marks = (lines: Line[]) => text(lines).join('').replace(/\s/g, '').length
const lit = (lines: Line[]) => lines.flatMap(l => l.filter(s => s.bg === COLORS.selected).map(s => s.s)).join('')

test('more of the card shows as t grows, from little at t = 0 to all of it at t = 1', () => {
  for (const card of CARDS) {
    const counts = TS.map(t => marks(animFrame(card, 60, t).lines))
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!)
    expect(counts[0]!).toBeLessThan(counts.at(-1)!)
    // the frame keeps the finished drawing's height, so the panel does not jump
    for (const t of TS) expect(animFrame(card, 60, t).lines.length).toBe(cardLayout(card, 60, -1).lines.length)
  }
})

test('t = 1 is the card as cardLayout draws it', () => {
  for (const card of CARDS) {
    for (const cols of [44, 60, 80]) {
      const a = animFrame(card, cols, 1)
      const b = cardLayout(card, cols, -1)
      expect(a.lines).toEqual(b.lines)
      expect(a.items).toEqual(b.items)
    }
  }
})

test('bars grow in order and their values count up', () => {
  const mid = text(animFrame(BAR, 60, 0.3).lines)
  const end = text(cardLayout(BAR, 60, -1).lines)
  expect(mid[0]!.split('█').length).toBeGreaterThan(1) // the first bar has started
  expect(mid[0]!).not.toContain('13,403')
  expect(mid[0]!.trim()).toMatch(/\d+$/)
  expect(mid[2]!.includes('2.5')).toBe(false) // the last has not
  expect(end[0]!).toContain('13,403')
})

test('a line draws its axes before its trace, and traces left to right', () => {
  const axes = text(animFrame(LINE, 60, 0.2).lines)
  expect(axes.join('').match(/[⠁-⣿]/)).toBe(null)
  const half = animFrame(LINE, 60, 0.6).lines
  const rows = text(half).slice(0, 10)
  const cols = rows.flatMap(r => [...r].flatMap((ch, x) => (/[⠁-⣿]/.test(ch) ? [x] : [])))
  const full = text(cardLayout(LINE, 60, -1).lines).slice(0, 10).flatMap(r => [...r].flatMap((ch, x) => (/[⠁-⣿]/.test(ch) ? [x] : [])))
  expect(Math.max(...cols)).toBeLessThan(Math.max(...full))
  expect(Math.min(...cols)).toBe(Math.min(...full))
})

test('a timeline\'s cursor sweeps the axis and events appear as it passes them', () => {
  const early = text(animFrame(TIMELINE, 60, 0.3).lines)
  // the sweep a line in the rule grey
  expect(early[0]).toContain('│')
  expect(early.join('\n')).toContain('First revision')
  expect(early.join('\n')).not.toContain('Last revert')
})

test('a table shows its heading first, then rows top down', () => {
  const lines = text(animFrame(TABLE, 60, 0.3).lines)
  expect(lines[0]).toContain('agent')
  expect(lines.join('\n')).toContain('alpha')
  expect(lines.join('\n')).not.toContain('delta')
})

test('example records slide in, and a highlight runs along the quoted words', () => {
  const sliding = text(animFrame(EXAMPLE, 60, 0.1).lines)
  const end = text(cardLayout(EXAMPLE, 60, -1).lines)
  expect(sliding[0]!.search(/\S/)).toBeGreaterThan(end[0]!.search(/\S/))
  expect(lit(animFrame(EXAMPLE, 60, 0.45).lines)).not.toBe('')
  expect(lit(animFrame(EXAMPLE, 60, 1).lines)).toBe('')
})

test('a diagram shows its nodes layer by layer, then its edges', () => {
  const first = text(animFrame(DIAGRAM, 70, 0.05).lines).join('\n')
  expect(first).toContain('Planner')
  expect(first).not.toContain('Merger')
  const nodes = text(animFrame(DIAGRAM, 70, 0.5).lines).join('\n')
  expect(nodes).toContain('Merger')
  expect(nodes).not.toContain('▼')
  expect(nodes).not.toContain('assigns')
  expect(text(animFrame(DIAGRAM, 70, 1).lines).join('\n')).toContain('▼')
})

test('a focus lights the value it names, and labels a line\'s point with its value', () => {
  const line = animFrame(LINE, 60, 1, { series: 'saves', x: '2026-06-18' })
  expect(lit(line.lines)).toContain('6,543')
  // the point itself in inverse, as the mark under the pointer is
  expect(line.lines.some(l => l.some(s => s.inv && /[⠁-⣿]/.test(s.s)))).toBe(true)

  expect(lit(animFrame(BAR, 60, 1, { row: 'probier' }).lines)).toContain('probier')
  expect(lit(animFrame(BAR, 60, 1, { row: 'probier' }).lines)).not.toContain('dse')

  const tl = animFrame(TIMELINE, 60, 1, { event: 2 })
  expect(lit(tl.lines)).toContain('The bot starts')
  expect(lit(tl.lines)).toContain('18 Jun 19:02')
  expect(lit(tl.lines)).not.toContain('Last revert')

  expect(lit(animFrame(TABLE, 60, 1, { row: 'beta', series: 'reverts' }).lines).trim()).toBe('19')

  const ex = lit(animFrame(EXAMPLE, 60, 1, { row: 'chat.jsonl#L40' }).lines)
  expect(ex).toContain('Fine, I stop now.')
  expect(ex).not.toContain('revert every edit')

  expect(lit(animFrame(DIAGRAM, 70, 1, { node: 'c' }).lines)).toContain('Coder')
  expect(lit(animFrame(DIAGRAM, 70, 1, { node: 'c' }).lines)).not.toContain('Planner')
  // a focus that names nothing on the card lights nothing
  expect(lit(animFrame(BAR, 60, 1, { row: 'nowhere' }).lines)).toBe('')
})

test('a citation\'s place becomes the focus of the value it cites', () => {
  expect(focusFromRef(LINE, 'card:l1#saves/2026-06-18')).toEqual({ series: 'saves', x: '2026-06-18' })
  expect(focusFromRef(BAR, 'card:b1#revisions/probier')).toEqual({ row: 'probier' })
  expect(focusFromRef(TABLE, 'card:tb1#reverts/beta')).toEqual({ series: 'reverts', row: 'beta' })
  expect(focusFromRef(TIMELINE, 'card:t1#time/2')).toEqual({ event: 2 })
  expect(focusFromRef(TIMELINE, 'revisions.jsonl#L9')).toEqual({ event: 3 })
  expect(focusFromRef(EXAMPLE, 'chat.jsonl#L40')).toEqual({ row: 'chat.jsonl#L40' })
  expect(focusFromRef(DIAGRAM, 'card:d1#node/r')).toEqual({ node: 'r' })
  expect(focusFromRef(BAR, 'card:other#revisions/probier')).toBe(undefined)
  // and the focus names the item cardLayout's readout and citations use
  const items = cardLayout(LINE, 60, -1).items
  expect(items[focusItem(LINE, items, { series: 'saves', x: '2026-06-18' })]!.open).toBe('card:l1#saves/2026-06-18')
})

test('no frame has a line wider than the card, with or without a focus', () => {
  const focus = { series: 'saves', x: '2026-06-20', row: 'sandbox', event: 3, node: 'm' }
  for (const card of CARDS) {
    for (const cols of [32, 44, 60, 80]) {
      for (const t of TS) {
        for (const f of [undefined, focus, { ...focus, row: card.kind === 'table' ? 'delta' : card.kind === 'example' ? 2 : 'sandbox' }]) {
          const lines = animFrame(card, cols, t, f).lines
          expect(Math.max(0, ...lines.map(lineWidth))).toBeLessThanOrEqual(cols)
        }
      }
    }
  }
})
