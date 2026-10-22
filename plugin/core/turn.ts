// turn.ts: whether main's turn runs now, in one place. Kept in $.state, so a reload of the plugin in the middle of a
// turn still knows it. Registered before the modules that ask, so its turn.start hook runs before theirs and its
// turn.complete hook after theirs: a module's own turn.complete hook still sees main's turn as running.
//
//   mainRuns($)   main's turn runs (marks draw its marks as pending; v waits for the answer)
import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface

const RUNS = { plugin: 'thimble', key: 'mainRuns' } as const

export async function mainRuns($: Engine): Promise<boolean> {
  return !!(await $.state.get(RUNS)).value
}

export const registerTurn: Register = on => {
  on('turn.start', { turnId: /\S/ }, async ($, e, next) => {
    if (e.agentId === undefined) await $.state.set(RUNS, true).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', { turnId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await $.state.set(RUNS, false).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
