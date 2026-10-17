// A label's panel says what one unit of it is and counts it as home does (bug hunt C14): a label over whole files has
// `whole files` lit on its `unit:` row (a run label `runs`), as the browser offers them, never `records of files`; its
// values are followed by `▒ unsure` with the count home's legend shows. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, LABEL, aboveAt, paneAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const T = { timeoutMs: 30_000 }
const WHOLE = { ...LABEL, name: 'admits a shortcoming', kind: 'prompt', spec: 'Does the report admit a shortcoming?', unit: 'agent', glob: '*/*.md', scope_files: 994, scope_unit: 'files', labels: ['admits', 'does not admit'], label_stats: { n_labeled: 994, counts: { admits: 745, 'does not admit': 249 } }, last_run: { total: 994, matched_total: 994, labeled: 994, status: 'done', limit: null } }

/** The label's panel, from the Labels view as the analyst opens it. */
async function labelPanel($: E, w: PanelWorld): Promise<M> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  const band = (await $.ui.mount(aboveAt(120))) as unknown as M
  await band.press({ key: 'above-summary-labels' })
  await band.unmount()
  await w.clock.advance(100)
  await w.clock.settle()
  await (await $.ui.mount(paneAt(116))).unmount()
  await w.clock.advance(100)
  await w.clock.settle()
  let m = (await $.ui.mount(paneAt(116))) as unknown as M
  const el = (await m.find({ type: 'Client', key: 'm:labels-list' })) as unknown as { props: { key: string } }
  await m.pointer({ type: 'down', x: 6, y: 0, button: 'left', in: el.props.key } as never)
  await w.clock.settle()
  await m.unmount()
  await (await $.ui.mount(paneAt(116))).unmount()
  await w.clock.settle()
  m = (await $.ui.mount(paneAt(116))) as unknown as M
  return m
}

const lit = (json: string, words: string) => json.includes(`{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":[" ${words} "]}`)

test("a whole-file label's panel lights `whole files` and counts its unsure records as home does", T, async ($, on) => {
  const w = panelWorld(on)
  w.states.labels = [WHOLE] as never
  w.unsure = [{ id: LABEL.id, name: WHOLE.name, noFit: 0, unsure: 18, total: 18, rows: [] }]
  const m = await labelPanel($, w)
  const text = words(await m.drawn())
  expect(text).toMatch(/unit: *records of files +whole files +runs +cards +sentences/)
  const json = JSON.stringify(await m.drawn())
  expect(lit(json, 'whole files')).toBe(true)
  expect(lit(json, 'records of files')).toBe(false)
  expect(text).toMatch(/● admits +━+ +745/)
  expect(text).toMatch(/● does not admit +━+ +249/)
  expect(text).toMatch(/▒ unsure +▒+ +18/)
  await m.unmount()
})

test("a run label's panel lights `runs`", T, async ($, on) => {
  const w = panelWorld(on)
  w.states.labels = [{ ...WHOLE, name: 'run went well', unit: 'run', glob: '*/', scope_unit: 'run folders' }] as never
  const m = await labelPanel($, w)
  const json = JSON.stringify(await m.drawn())
  expect(lit(json, 'runs')).toBe(true)
  expect(lit(json, 'records of files')).toBe(false)
  expect(words(await m.drawn())).not.toContain('▒ unsure')
  await m.unmount()
})
