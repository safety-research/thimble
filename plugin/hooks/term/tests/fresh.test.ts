// /thimble fresh and /thimble restore put another folder in the workspace's place (home's `instance` names which):
// what the session counts as its citations is the new folder's, none for a fresh one, the archived run's again after a
// restore. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { KEPT_FILE, resetKept } from '../kept'
import { cid } from '../lib'
import { CWD, SID, WS, world } from './fixtures'
import type { World } from './fixtures'
import { aboveAt, words } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const KEPT = `${WS}/${KEPT_FILE}`
const CARD_CITE = '[[4579|card:ff73e071#pages/TOTAL]]'
const FILE_CITE = '[[3|README.md#L3]]'

/** The thimble line's words. */
async function line($: E): Promise<string> {
  const m = (await $.ui.mount(aboveAt(184))) as unknown as M
  const said = words(await m.find({ type: 'Box', key: 'above-summary' }))
  await m.unmount()
  return said
}

/** Another folder in the workspace's place, as the server moves one there: home names it, the cards are its own, and
 *  the cards' folder's stamp changes, which the session's timer sees. */
async function swap(w: World, instance: string, cells: World['cells'], kept: string | null, stamp: number): Promise<void> {
  w.cells = cells
  if (kept === null) w.files.delete(KEPT)
  else w.files.set(KEPT, kept)
  w.states.home = { ...w.states.home, cards: Object.keys(cells).length, instance } as typeof w.states.home
  w.stamps.set(`${WS}/notebooks`, stamp)
  await w.clock.advance(1100)
  await w.clock.settle()
}

test('after /thimble fresh the thimble line counts none of the run before\'s citations, and after /thimble restore that run\'s again (bug hunt 7, H11)', { timeoutMs: 30_000 }, async ($, on) => {
  // the line read `citations 6  6 failed` in red after /thimble fresh: the answers' citations of the archived run,
  // whose cards the fresh workspace does not hold
  resetKept()
  const w = world(on)
  const cites = [
    { id: cid(CARD_CITE), raw: CARD_CITE, display: '4579', ref: 'card:ff73e071#pages/TOTAL', row: 'r1', at: 1 },
    { id: cid(FILE_CITE), raw: FILE_CITE, display: '3', ref: 'README.md#L3', row: 'r2', at: 2 },
  ]
  const archived = JSON.stringify({ rows: {}, last: { reply: '', cards: [] }, sessions: { [SID]: { cites, shown: ['ff73e071'] } } })
  w.files.set(KEPT, archived)
  w.states.home = { ...w.states.home, instance: '64769:1001' } as typeof w.states.home
  const cells = w.cells
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  // the answers' two, and the other one of the drawn card's takeaway
  expect(await line($)).toContain('citations 3')
  await swap(w, '64769:2002', {} as World['cells'], null, 2)
  const fresh = await line($)
  expect(fresh).toContain('citations 0')
  expect(fresh).not.toContain('failed')
  // the new folder's file holds none of the run before's, and names its folder
  const now = JSON.parse(w.files.get(KEPT) ?? '{}') as { folder?: string; sessions?: Record<string, { cites: unknown[]; shown: string[] }> }
  expect(now.folder).toBe('64769:2002')
  expect(now.sessions?.[SID]?.cites ?? []).toEqual([])
  await swap(w, '64769:1001', cells, archived, 3)
  expect(await line($)).toContain('citations 3')
})
