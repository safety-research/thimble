// The labels' records with no category fit and those the label is unsure of (SPEC-v2 J6, 3.11, C8): the Labels view
// draws their counts as parts of each label's bar and legend (`▒ unsure`, `░ no fit`), not the records, which the
// label's panel lists, a press away, three at a time with `… N more`. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, LABEL, aboveAt, paneAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const T = { timeoutMs: 30_000 }
const ROWS = [
  { ref: 'revisions.jsonl#L20', value: null, confidence: null, kind: 'no-fit' as const, text: 'A revision the label could not place.' },
  { ref: 'revisions.jsonl#L21', value: 'other', confidence: 0.9, kind: 'no-fit' as const, text: 'A value off the label\'s list.' },
  { ref: 'revisions.jsonl#L30', value: 'proxy-link', confidence: 0.31, kind: 'unsure' as const, text: 'Maybe a proxy: reader.example/x' },
  { ref: 'revisions.jsonl#L31', value: 'none', confidence: 0.52, kind: 'unsure' as const, text: 'A plain edit with a link.' },
  { ref: 'revisions.jsonl#L32', value: 'none', confidence: 0.58, kind: 'unsure' as const, text: 'Another plain edit.' },
]

async function start($: E, w: PanelWorld): Promise<void> {
  w.unsure = [{ id: LABEL.id, name: LABEL.name, noFit: 2, unsure: 3, total: 5, rows: ROWS }]
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** The rows a list's Client draws. */
async function listText(m: M, key: string): Promise<string[]> {
  const el = (await m.find({ type: 'Client', key })) as unknown as { props: { props: { lines: { s: string }[][] } } } | undefined
  return (el?.props.props.lines ?? []).map(l => l.map(x => x.s).join('').replace(/\s+$/, ''))
}

/** The Labels view, from the thimble line's `labels N` (the labels' count; their counts of no fit and unsure are in
 *  the view). */
async function labelsView($: E, w: PanelWorld): Promise<M> {
  const band = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-summary' }))).toContain('labels 1')
  await band.press({ key: 'above-summary-labels' })
  await band.unmount()
  await w.clock.advance(100)
  await w.clock.settle()
  await (await $.ui.mount(paneAt(96))).unmount()
  await w.clock.advance(100)
  await w.clock.settle()
  return (await $.ui.mount(paneAt(96))) as unknown as M
}

test("the Labels view draws each label's distribution with no fit and unsure among its parts; its panel lists those records", T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  let m = await labelsView($, w)
  const rows = await listText(m, 'm:labels-list')
  // one row for the label, its bar and its total (its 14,591 records and the 2 no value names), then its legend
  expect(rows).toEqual([
    expect.stringMatching(/^❯ ● links through a fetch proxy +regex · revisions\.jsonl +[█▒░]{28} {2}14,593$/),
    expect.stringMatching(/^ {4}● proxy-link +5,191 {3}● none +9,400 {3}▒ unsure +3 {3}░ no fit +2$/),
  ])
  // the list reads the counts only, never a label's records
  expect(w.calls.some(c => c[2] === 'label-unsure' && c.includes('--label'))).toBe(false)
  // a click on the label opens its panel, whose examples list the records no category fit, then the unsure ones
  const el = (await m.find({ type: 'Client', key: 'm:labels-list' })) as unknown as { props: { key: string } }
  await m.pointer({ type: 'down', x: 6, y: 1, button: 'left', in: el.props.key } as never)
  await w.clock.settle()
  await m.unmount()
  m = (await $.ui.mount(paneAt(96))) as unknown as M
  await m.press({ key: 'hk-examples' })
  await w.clock.settle()
  await m.unmount()
  // the first drawing asks for the label's records (a timer reads them); the next shows them
  await (await $.ui.mount(paneAt(96))).unmount()
  await w.clock.advance(100)
  await w.clock.settle()
  m = (await $.ui.mount(paneAt(96))) as unknown as M
  const text = words(await m.drawn())
  expect(text).toContain('no category fit or unsure')
  expect(text).toContain('A revision the label could not place.')
  expect(text).toContain('… 2 more')
  expect(w.calls.some(c => c[2] === 'label-unsure' && c.includes('--label') && c.includes(LABEL.id) && c.includes('3'))).toBe(true)
  await m.unmount()
})
