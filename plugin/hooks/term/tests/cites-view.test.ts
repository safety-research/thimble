// The Citations view (citesview.tsx, SPEC-v2 3.8): the chat's citations and each card's links check, the problems first
// (refuted and missing, then differs, typed and quiet, then pending, then ok); a card's problem listed with its card.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cid } from '../lib'
import { citePlace } from '../citesview'
import { CWD, aboveAt, paneAt, panelWorld, shown, words } from './fixtures-panel'
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

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

test('one count everywhere (bug hunt B8): the footer under an answer, the thimble line and the view count the same citations, the answer\'s words with a chip among them and the takeaway of the card drawn under it, each once; a chip\'s row names its card', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  // main's answer cites a value of the card it made, as the card's takeaway does, and another card whole (a chip)
  const VALUE = '[[4579|card:ff73e071#pages/TOTAL]]'
  const CHIP = '[[card:a0frame0]]'
  const TAKEAWAY_ONLY = '[[14592|card:ff73e071#revisions/TOTAL]]'
  const answer = `The export holds ${VALUE} pages; each file's records are on their own card ${CHIP}.`
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] } } as never).catch(() => undefined)
  await $.turn.complete({ turnId: 't1', answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  // the answer's citations as the transcript's lane keeps them (C13 citeIndex), all three checked and found
  w.t.citeIndex = [
    { id: cid(VALUE), raw: VALUE, display: '4579', ref: 'card:ff73e071#pages/TOTAL', row: 'r1', at: 1 },
    { id: cid(CHIP), raw: CHIP, display: null, ref: 'card:a0frame0', row: 'r1', at: 1 },
  ]
  const ok = (ref: string) => ({ ref, display: null, status: 'ok', why: '', kind: 'cell', lines: [], at: 1 })
  w.t.verdicts = { [cid(VALUE)]: ok('card:ff73e071#pages/TOTAL'), [cid(CHIP)]: ok('card:a0frame0'), [cid(TAKEAWAY_ONLY)]: ok('card:ff73e071#revisions/TOTAL') }
  let ui = (await $.ui.mount(MESSAGE('r1', answer))) as unknown as M
  await w.clock.advance(1100)
  await w.clock.settle()
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', answer))) as unknown as M
  // 4579 (the words and the takeaway cite it alike: once), the chip, and the takeaway's 14592
  expect(shown(await ui.find({ key: 'footer-r1' }))).toContain('3 citations · 1 card')
  await ui.unmount()
  const band = (await $.ui.mount(aboveAt(184))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-summary' }))).toContain('citations 3 ')
  expect(words(await band.find({ type: 'Box', key: 'above-summary' }))).not.toContain('◌')
  await band.unmount()
  await $.command.run({ command: 'thimble:thimble', args: 'citations' } as never)
  await w.clock.settle()
  const m = (await $.ui.mount(paneAt(96))) as unknown as M
  expect(words(await m.drawn())).toContain('3 citations')
  const rows = await listText(m, 'm:citations-list')
  expect(rows).toHaveLength(3)
  // the chip by its card's question, never `(no words) · the card`
  expect(rows).toContain('    card "How many records does each file hold?" · found')
  expect(rows.join('\n')).not.toContain('(no words)')
  expect(rows.find(r => r.includes('14592'))).toMatch(/^ {4}14592 · revisions TOTAL · found +card 1$/)
  await m.unmount()
})

test("a card cell's place names its column and row as the labels they stand for, never their %XX (bug hunt B18)", () => {
  // as the Citations view and home's Citations list name it
  expect(citePlace('card:far-apart-average#mean%20merged%20PRs/managed%5Fprs')).toBe('mean merged PRs managed_prs')
  expect(citePlace('card:far-apart-average#mean merged PRs/emergent%5Fprs%5Fissues')).toBe('mean merged PRs emergent_prs_issues')
  // a label with no %XX as written
  expect(citePlace('card:x#pages/TOTAL')).toBe('pages TOTAL')
})
