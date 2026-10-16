// The summary line above the prompt (band.tsx, SPEC-v2 3.8): after activation its counts come from the session's state
// (citations found and not found, coverage as the read share of the data by size).
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { percent } from '../band'
import { cid } from '../lib'
import { CWD, SUMMARY, aboveAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function band($: E, columns = 120): Promise<M> {
  return (await $.ui.mount(aboveAt(columns))) as unknown as M
}

/** The summary line's words, or '' when it does not show. */
async function line(m: M): Promise<string> {
  const row = await m.find({ type: 'Box', key: 'above-summary' })
  return row ? words(row) : ''
}

const CHAT = '[[4579|README.md#L3]]'
const BAD = '[[99|README.md#L99]]'

test('after activation the line counts from state: citations ✓ and ×, coverage as the read share of the data by size, or the files read with no index yet; nothing is new at activation', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.citeIndex = [
    { id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 },
    { id: 'c2', raw: BAD, display: '99', ref: 'README.md#L99', row: 'r1', at: 2 },
  ]
  w.t.verdicts = { [cid(CHAT)]: { status: 'ok' }, [cid(BAD)]: { status: 'missing' } }
  w.t.coverageSummary = SUMMARY
  await start($, w)
  const m = await band($)
  expect(await line(m)).toBe('  thimblecitations ✓1 ×1coverage 15%open ›')
  expect(await m.find({ type: 'Button', key: 'above-summary-dismiss' })).toBeUndefined()
  // `×1` in red
  expect(JSON.stringify(await m.find({ type: 'Box', key: 'above-summary' }))).toContain('×1')
  await m.unmount()
  // under 1%: a decimal kept
  w.t.coverageSummary = { ...SUMMARY, size: { read: 30_000, searched: 0, total: 14_000_000 } }
  const m1 = await band($)
  expect(await line(m1)).toContain(`coverage ${percent(30_000, 14_000_000)}`)
  expect(percent(30_000, 14_000_000)).toBe('0.2%')
  await m1.unmount()
  // no index yet (no size): the files read
  w.t.coverageSummary = { ...SUMMARY, records: { seen: 0, total: 0, counted: false }, size: null }
  const m2 = await band($)
  expect(await line(m2)).toContain('coverage 3 of 13 files')
  await m2.unmount()
  // a summary without totals (the transcript lane's stand-in): the files, as before
  w.t.coverageSummary = { files: SUMMARY.files, records: { seen: 0, total: 0, counted: false }, line: 'read 3 of 13 files' }
  const m3 = await band($)
  expect(await line(m3)).toContain('coverage 3 of 13 files')
  await m3.unmount()
})
