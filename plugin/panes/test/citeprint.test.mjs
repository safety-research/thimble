// citeprint.test.mjs: a citation whose values a query printed, and the code section with its output.
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { program } from '../tray.js'
import { drawnCard, sourceCard } from '../../shell/cards.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'

const DK = globalThis.DrawKit
const draw = p => runProgram(p, { w: 84, h: 20, mode: 'pane' })
function tray(card, { key, label = '2 April 2025 to 18 September 2026', ref = 'r4' } = {}) {
  const stack = [{ row: 'm2', i: 0, kind: 'cite', ref, label }]
  const opts = { w: 90, h: 24, mode: 'pane', state: { stack } }
  const want = DK.run(program, { threads: [], steps: {} }, opts).wants[0].key
  const d = DK.run(program, { threads: [], steps: {} }, { ...opts, got: { [want]: card }, ...(key ? { event: { type: 'key', key } } : {}) })
  assert.equal(d.error, undefined, d.error && d.error.message)
  const after = key ? DK.run(program, { threads: [], steps: {} }, { ...opts, state: d.state, got: { [want]: card } }) : d
  return gridText(renderTerm(after, { w: 90 }))
}

const MONTHS = ['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-09']
const OUT = '1840 2025-04-02 08:12:00+00:00 2026-09-18 21:40:11+00:00\n  month  messages\n' + MONTHS.map((m, i) => `${m}  ${100 + i}`).join('\n') + '\n'
const QUERY = { id: 'r4', about: 'messages per month', keys: ['month'], lineage: 'superset',
  code: 'df = load("chat.jsonl", fields=["created_at"])\ndf["month"] = df.created_at.str[:7]\nt = tally(df, "month")\nprint(len(df), df.created_at.min(), df.created_at.max())\nt',
  stdout: OUT, table: MONTHS.map((m, i) => ({ month: m, messages: 100 + i })), inputs: [{ path: 'chat.jsonl', rows_read: 1840 }] }
const NOTE = "these 1,840 rows share the output row's key, but a count column of r4 disagrees: they hold more rows than the value counts"
const line1 = OUT.split('\n')[0]
const SHOWN = { dates: ['2 April 2025', '18 September 2026'], missing: [], rows: [], cols: [], printed: 13,
  lines: [{ n: 1, text: line1, at: [[5, 15], [31, 41]] }] }
const RESOLVED = { ref: 'r4', count: 1840, rows: ['chat.jsonl#L1-1840'], records: [], notes: [NOTE], chain: [{ step: 'query', id: 'r4' }], shown: SHOWN }

test('a citation of values the query only printed: the print line of its code, and the printed line with the values lit', async () => {
  const card = await drawnCard(sourceCard({ ref: 'r4', label: '2 April 2025 to 18 September 2026', resolved: RESOLVED, query: QUERY }), draw)
  const text = tray(card)
  assert.match(text, /print\(len\(df\), df\.created_at\.min\(\), df\.created_at\.max\(\)\)/)
  assert.ok(text.includes('2025-04-02 08:12:00+00:00 2026-09-18'), text)
  // not the first rows of the monthly table
  assert.ok(!/2025-05\s+101/.test(text), text)
  // the values are lit (bold, in the accent tone) in the drawing
  const cells = renderTerm(DK.run(program, { threads: [], steps: {} }, { w: 90, h: 24, mode: 'pane', state: { stack: [{ row: 'm2', i: 0, kind: 'cite', ref: 'r4', label: 'x' }] }, got: {} }), { w: 90 })
  assert.ok(cells)
})

test('c shows the code and its output, the cited values marked; no lineage diagnostics', async () => {
  const card = await drawnCard(sourceCard({ ref: 'r4', label: '2 April 2025 to 18 September 2026', resolved: RESOLVED, query: QUERY }), draw)
  const text = tray(card, { key: 'c' })
  assert.match(text, /tally\(df, "month"\)/)
  assert.match(text, /output/)
  assert.ok(text.includes('2025-04-02 08:12:00+00:00'), text)
  assert.ok(text.includes('2025-04  100'), text)
  assert.ok(!/count column|share the output row|lineage/.test(text), text)
})

test("c marks the cited cell of a tally in its output, as the tray marks it", async () => {
  const q = { id: 'r2', about: 'chat messages by speaker type', keys: ['speaker'], code: 'tally(load("chat.jsonl"), "speaker")', table: [{ speaker: 'agent', n: 173493 }, { speaker: 'human', n: 9992 }], stdout: 'speaker       n\nagent    173493\nhuman      9992\n' }
  const shown = { dates: [], missing: [], rows: [], cols: [], printed: 3, lines: [{ n: 2, text: 'agent    173493', at: [[9, 15]] }] }
  const card = await drawnCard(sourceCard({ ref: 'r2#speaker=agent@n', label: '173,493', resolved: { ref: 'r2#speaker=agent@n', count: 0, rows: [], records: [], chain: [{ step: 'query', id: 'r2', value: 173493 }], shown }, query: q }), draw)
  const drawn = card.sections.find(s => s.id === 'code').drawings
  const marked = JSON.stringify(drawn).includes('173493')
  assert.ok(marked)
  const text = tray(card, { key: 'c', label: '173,493', ref: 'r2#speaker=agent@n' })
  assert.match(text, /▌ agent\s+173493/)
})

test('the rows that hold month-level dates, not the first rows', async () => {
  const shown = { dates: ['September 2026'], missing: [], rows: [10], cols: ['month'], printed: 13, lines: [] }
  const card = await drawnCard(sourceCard({ ref: 'r4', label: 'September 2026', resolved: { ...RESOLVED, shown }, query: QUERY }), draw)
  const text = tray(card)
  assert.match(text, /▌\s*2026-09/)
  assert.ok(!/2025-04\s+100/.test(text), text)
})
