// turn.ts: main's turn now, in one place. Kept in $.state, so a reload of the plugin in the middle of a turn still knows
// it. Registered before the modules that ask, so its turn.start hook runs before theirs and its turn.complete hook after
// theirs: a module's own turn.complete hook still sees main's turn as running.
//
//   mainRuns($)   main's turn runs (marks draw its marks as pending; v waits for the answer)
//   mainTurn($)   the id of main's turn that runs, or '' (cards: a card drawn in this turn can still be drawn again in
//                 its place on Claude Code's main screen)
import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface

const TURN = { plugin: 'thimble', key: 'mainTurn' } as const

export async function mainTurn($: Engine): Promise<string> {
  return (await $.state.get(TURN)).value ?? ''
}

export async function mainRuns($: Engine): Promise<boolean> {
  return !!(await mainTurn($))
}

export const registerTurn: Register = on => {
  on('turn.start', { turnId: /\S/ }, async ($, e, next) => {
    if (e.agentId === undefined) await $.state.set(TURN, e.turnId).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', { turnId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await $.state.set(TURN, null).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
