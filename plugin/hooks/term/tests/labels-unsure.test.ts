// The labels' records with no category fit and those the label is unsure of (SPEC-v2 J6, 3.11, C8): the Labels view
// lists them under each label, no-fit first, then unsure (lowest confidence first), three a label with `↓ more` to page;
// the label editor's examples start with them. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, LABEL, WS, aboveAt, paneAt, panelWorld, words } from './fixtures-panel'
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

/** The Labels view, from the thimble line's `labels N` (the labels' count; their records to check are in the view). */
async function labelsView($: E, w: PanelWorld): Promise<M> {
  const band = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-summary' }))).toContain('labels 1')
  await band.press({ key: 'above-summary-labels' })
  await band.unmount()
  await w.clock.advance(100)
  await w.clock.settle()
  // the first drawing asks for each label's records (a timer reads them); the next shows them
  await (await $.ui.mount(paneAt(96))).unmount()
  await w.clock.advance(100)
  await w.clock.settle()
  return (await $.ui.mount(paneAt(96))) as unknown as M
}

test('the Labels view lists under each label its records with no category fit, then its unsure ones, three with `↓ more`', T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  let m = await labelsView($, w)
  let rows = await listText(m, 'm:labels-list')
  expect(rows[0]).toMatch(/^❯ ● links through a fetch proxy +regex · all 14,591 · 2 no fit · 3 unsure$/)
  expect(rows.slice(1, 4).map(r => r.trim())).toEqual([
    expect.stringMatching(/^no fit +A revision the label could not place\.$/),
    expect.stringMatching(/^no fit +other +A value off the label's list\.$/),
    expect.stringMatching(/^unsure 0\.31 +proxy-link +Maybe a proxy: reader\.example\/x$/),
  ])
  expect(rows[4]!.trim()).toBe('↓ 2 more')
  expect(w.calls.some(c => c[2] === 'label-unsure' && c.includes('--label') && c.includes(LABEL.id) && c.includes('3'))).toBe(true)
  // `↓ more`: the next three
  const el = (await m.find({ type: 'Client', key: 'm:labels-list' })) as unknown as { props: { key: string } }
  await m.pointer({ type: 'down', x: 6, y: 4, button: 'left', in: el.props.key } as never)
  await w.clock.advance(100)
  await w.clock.settle()
  await m.unmount()
  m = (await $.ui.mount(paneAt(96))) as unknown as M
  rows = await listText(m, 'm:labels-list')
  expect(rows.map(r => r.trim()).filter(r => r.startsWith('unsure'))).toEqual([expect.stringMatching(/^unsure 0\.31/), expect.stringMatching(/^unsure 0\.52/), expect.stringMatching(/^unsure 0\.58/)])
  expect(rows.some(r => r.includes('more'))).toBe(false)
  await m.unmount()
})

test("the label editor's examples start with the records of no category fit and the unsure ones", T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  const m0 = await labelsView($, w)
  await m0.press({ key: 'label-open-0' })
  await w.clock.settle()
  await m0.unmount()
  let m = (await $.ui.mount(paneAt(96))) as unknown as M
  await m.press({ key: 'hk-examples' })
  await w.clock.advance(100)
  await w.clock.settle()
  await m.unmount()
  m = (await $.ui.mount(paneAt(96))) as unknown as M
  const text = words(await m.drawn())
  const fit = text.indexOf('no category fit or unsure')
  const first = text.indexOf('A revision the label could not place.')
  const examples = text.indexOf('SEC download')
  expect(fit).toBeGreaterThan(0)
  expect(first).toBeGreaterThan(fit)
  // before the examples the label gave each value
  expect(examples).toBeGreaterThan(first)
  expect(text).toContain('Maybe a proxy: reader.example/x')
  expect(text).toContain('… 2 more')
  await m.unmount()
  void WS
})
