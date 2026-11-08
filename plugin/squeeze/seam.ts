// seam.ts: where Simplify and Catch-up (two settings; Simplify's key is squeezeAnswers) meet the rest of thimble
// (core/answerview.ts calls each function by name, since Claude Code follows `$` only into functions a file declares or
// imports). s writes a simpler version of the last answer below it in one press, as b writes a catch-up below the
// replies that piled up. The block's last row names the choices, each acting at once: 1 shorter, 2 longer, 3 explain
// more, 4 assume more, 0 hide. The feature's own modules are
// beside this file: term.ts (the records, the call that writes a version, the simpler version, the catch-up, what
// Claude hears), ui.ts (the keys, the row of choices, the bar, the drawing), cards.ts (the cards a squeeze changes),
// chips.mjs (pure: the levels, the choices, the request, the reply, the checks), prompts/squeeze.md.
//
//   SQUEEZE_KEYS                       its letters at an empty prompt, which no card may take (hooks/keys.ts ownKeys);
//                                      the row's keys (1–4, 0) are no letters, which no card takes
//   squeezeView($, row, text)          the text a row of Claude's shows now in place of what Claude wrote: a version
//                                      s rewrote in place in 0.10.12 and earlier (a resumed session's), the part of
//                                      it written in so far, `dim` while a rewrite runs; null: the row as Claude
//                                      wrote it
//   squeezeUnder($, els, row, cols, cardsIn)  what stands under the row after its cards: its simpler version, or the
//                                      catch-up of the replies it ends (the rule down its side, its head line, its
//                                      words with their marks, the replies' explainers and the cards it places),
//                                      and on the newest answer its row of choices), why a block's first version
//                                      failed, what a squeeze left out of its cards
//   squeezeUnderCard($, els, id, cols) what stands under one card: what a squeeze changed of it
//   squeezeHidesCard($, id)            whether a card is left out of the version of its answer shown now
//   squeezeKey($, key, until)          s and b, and the row's keys 1–4 and 0 while a block stands on the newest
//                                      answer: a taker as hooks/keys.ts takes it
//   squeezeBar($, on, preview)         its items at the bar's left (`s simplify` while the newest answer has no block,
//                                      `b catch up on N replies`)
//   registerSqueeze                    its own hooks: the prompt that carries the version told to Claude, a resumed
//                                      session's cards, the end of main's turn (s, pressed while it ran, acts on its
//                                      answer)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { TextView } from '../core/answerview'
import type { Take } from '../hooks/keys'
import { restoreCardsShown } from './cards'
import { promptSent } from './term'
import { answerDone, barItems, type CardsIn, hidesCard, promptWent, squeezeKeyTake, turnChips, underCardLine, underRow, viewOf } from './ui'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const SQUEEZE_KEYS = ['s', 'b']

export async function squeezeView($: Engine, row: string, _text: string): Promise<TextView | null> {
  return viewOf($, row)
}

export async function squeezeUnder($: Engine, els: Any, row: string, cols: number, cardsIn?: CardsIn): Promise<Any[]> {
  return underRow($, els, row, cols, cardsIn)
}

export async function squeezeUnderCard($: Engine, els: Any, id: string, _cols: number): Promise<Any[]> {
  return underCardLine($, els, id)
}

export async function squeezeHidesCard($: Engine, id: string): Promise<boolean> {
  return hidesCard($, id)
}

export async function squeezeKey($: Engine, key: string, _until: number): Promise<Take | null> {
  return squeezeKeyTake($, key)
}

export async function squeezeBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  return barItems($, on, preview)
}

/** A /clear or a /resume (hooks/turnover.ts): the wait goes, and the cards show the versions the new conversation's
 *  squeezes left. */
export async function turnSqueeze($: Engine): Promise<void> {
  await turnChips($)
  await restoreCardsShown($, true)
}

export const registerSqueeze: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreCardsShown($) } catch { /* the cards draw as they stand */ }
    return r
  }).catch(($, e, next) => next(e))

  // main's turn ends: s, pressed while its answer was being written, acts on that answer (ui.ts answerDone). The answer
  // is set before this hook hears the end (core/answers.ts)
  on('turn.complete', { turnId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await answerDone($, e.turnId).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // a prompt that carries thimble's report (core/tell.ts): the versions waiting in it are the ones Claude knows now;
  // the person's own prompt ends the wait
  on('prompt.submit', { origin: { kind: /^(composer|bridge|plugin)$/ } }, async ($, e, next) => {
    const r = await next(e)
    if (e.command || e.isMeta) return r
    try {
      await promptSent($)
      if ((e.origin as { kind?: string } | undefined)?.kind !== 'plugin') await promptWent($)
    } catch {
      // the version is told again with the next prompt
    }
    return r
  }).catch(($, e, next) => next(e))
}
