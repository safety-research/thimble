// The Citations view (citesview.tsx, SPEC-v2 3.8): the chat's citations and each card's links check, the problems first
// (refuted and missing, then differs, typed and quiet, then pending, then ok); a card's problem listed with its card.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cid } from '../lib'
import { CWD, paneAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function listText(m: M, key: string): Promise<string[]> {
  const el = (await m.find({ type: 'Client', key })) as unknown as { props: { props: { lines: { s: string }[][] } } } | undefined
  return (el?.props.props.lines ?? []).map(l => l.map(x => x.s).join('').replace(/\s+$/, ''))
}

const OK = '[[4579|README.md#L3]]'
const MISSING = '[[99|README.md#L99]]'
const PENDING = '[[Each record|README.md#L5]]'

function seeded(w: PanelWorld): void {
  w.t.citeIndex = [
    { id: 'c1', raw: OK, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 },
    { id: 'c3', raw: PENDING, display: 'Each record', ref: 'README.md#L5', row: 'r1', at: 2 },
    { id: 'c2', raw: MISSING, display: '99', ref: 'README.md#L99', row: 'r1', at: 3 },
  ]
  const v = (ref: string, display: string, status: string, why = '') => ({ ref, display, status, why, kind: 'record', lines: [], at: 1 })
  w.t.verdicts = { [cid(OK)]: v('README.md#L3', '4579', 'ok'), [cid(MISSING)]: v('README.md#L99', '99', 'missing', 'line 99 out of range'), [cid(PENDING)]: v('README.md#L5', 'Each record', 'pending') }
  w.cells.ff73e071 = { ...w.cells.ff73e071, verification: { links: { status: 'done', checked: true, resolved: [], broken: [{ value: '14592', ref: 'card:ff73e071#revisions/TOTAL', why: 'a script got 14591', source: '14591' }], typed: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL', why: 'the code types it in' }] } } }
}

test('the citations, problems first: a card\'s refuted citation and the chat\'s missing one, then typed, then pending, then ok; a card\'s rows name its card', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  seeded(w)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  await $.command.run({ command: 'thimble:thimble', args: 'citations' } as never)
  await w.clock.settle()
  const m = (await $.ui.mount(paneAt(96))) as unknown as M
  const rows = await listText(m, 'm:citations-list')
  expect(rows.map(r => r.slice(2, 3))).toEqual(['×', '×', '!', '◌', ' '])
  expect(rows[0]).toMatch(/^❯ × 14592 · revisions TOTAL · a script got 14591 +card 1$/)
  expect(rows[1]).toMatch(/^ {2}× 99 · README\.md line 99 · line 99 out of range$/)
  expect(rows[2]).toMatch(/^ {2}! 4579 · pages TOTAL · the code types it in +card 1$/)
  expect(rows[3]).toBe('  ◌ Each record · README.md line 5 · checking')
  // found: no glyph, never a ✓
  expect(rows[4]).toBe('    4579 · README.md line 3 · found')
  expect(words(await m.drawn())).toContain('5 citations · ◌ checking 1 · 3 failed')
  await m.unmount()
})
