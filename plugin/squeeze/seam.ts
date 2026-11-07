// seam.ts: where Simplify and Catch-up (two settings; Simplify's key is squeezeAnswers) meet the rest of thimble
// (core/answerview.ts calls each function by name, since Claude Code follows `$` only into functions a file declares or
// imports). s writes a simpler version of the last answer below it in one press, as b writes a catch-up below the
// replies that piled up. The block's last row names the choices, each acting at once: 1 shorter, 2 longer, 3 explain
// more, 4 assume more, + your own (the person's words, typed after /rewrite), 0 remove. The feature's own modules are
// beside this file: term.ts (the records, the call that writes a version, the simpler version, the catch-up, what
// Claude hears), ui.ts (the keys, the row of choices, the bar, the drawing), cards.ts (the cards a squeeze changes),
// chips.mjs (pure: the levels, the choices, the request, the reply, the checks), prompts/squeeze.md.
//
//   SQUEEZE_KEYS                       its letters at an empty prompt, which no card may take (hooks/keys.ts ownKeys);
//                                      the row's keys (1–4, +, 0) are no letters, which no card takes
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
//   squeezeKey($, key, until)          s and b, and the row's keys 1–4, + and 0 while a block stands on the newest
//                                      answer: a taker as hooks/keys.ts takes it
//   squeezeBar($, on, preview)         its items at the bar's left (`s simplify` while the newest answer has no block,
//                                      `b catch up on N replies`; `rewrite for…` while + put /rewrite in the box)
//   registerSqueeze                    its own hooks: /rewrite (what + writes in the prompt box, hidden from the
//                                      typeahead) and its autocomplete, the prompt that carries the version told to
//                                      Claude, a resumed session's cards, the end of main's turn (s, pressed while it
//                                      ran, acts on its answer)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { TextView } from '../core/answerview'
import type { Take } from '../hooks/keys'
import { featureOn } from '../settings/features.mjs'
import { restoreCardsShown } from './cards'
import { ownWords } from './chips.mjs'
import { catchUpStands } from './chips.mjs'
import { promptSent, recOf, slotOf } from './term'
import { addOwn, answerDone, barItems, type CardsIn, hidesCard, hintNow, ownEarlier, promptHasKeys, promptWent, simplifyNow, squeezeKeyTake, targetNow, turnChips, underCardLine, underRow, viewOf } from './ui'

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

/** A /clear or a /resume (hooks/turnover.ts): the hint and the wait go, the person's own words of the earlier
 *  conversation are not offered, and the cards show the versions the new conversation's squeezes left. */
export async function turnSqueeze($: Engine): Promise<void> {
  await turnChips($)
  await restoreCardsShown($, true)
}

export const registerSqueeze: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreCardsShown($) } catch { /* the cards draw as they stand */ }
    try {
      await $.command.register({ name: 'rewrite', description: 'Rewrite the simpler version of the last answer as you say: /rewrite for my manager', argumentHint: '[who or what to rewrite it for]', immediate: true })
    } catch {
      // s at an empty prompt still simplifies
    }
    return r
  }).catch(($, e, next) => next(e))

  // /rewrite is not a command people type: + under a block writes it in the prompt box, and the person's words follow it.
  // So the typeahead and /help leave it out; it runs when the box sends it
  on('command.describe', { command: /^(thimble:)?rewrite$/ }, async ($, e, next) => ({ ...(await next(e)), isHidden: true })).catch(($, e, next) => next(e))

  // /rewrite <words>: the simpler version or catch-up that + was pressed on (else the one standing on the newest answer;
  // with none, a simpler version of it is written first) rewritten as the person's words ask. It never rewrites a
  // message in place
  on('command.run', { command: 'rewrite' }, async ($, e) => {
    if (!featureOn('squeezeAnswers')) return { text: 'Simplify is off. Turn it on in /thimble-settings to use it.' }
    if (!ownWords(e.args)) return { text: 'Say how to rewrite it after /rewrite, as in: /rewrite for my manager' }
    const hinted = (await hintNow($))?.id
    const block = hinted ? await recOf($, hinted) : null
    let id = block && catchUpStands(block) ? block.id : await targetNow($)
    if (id && !slotOf(id)) id = await simplifyNow($, id)
    if (!id || !(await recOf($, id))) return { text: 'No answer to simplify yet: ask Claude something first.' }
    await addOwn($, id, e.args)
    return {}
  })

  // what follows /rewrite: the words typed earlier this session, offered as the words are typed
  on('prompt.autocomplete', async ($, e, next) => {
    const r = await next(e)
    if (!/^\/rewrite\s/.test(e.text) || e.start < 9) return r
    const typed = e.text.slice(9, e.cursor).toLowerCase()
    const hits = (await ownEarlier($)).filter(d => d.toLowerCase().startsWith(typed) && d.toLowerCase() !== typed).reverse().slice(0, 5)
    if (!hits.length) return r
    // a row writes the whole words in place of what follows /rewrite (the token is the last word typed)
    const head = e.text.slice(9, e.start)
    return { suggestions: [...r.suggestions, ...hits.filter(d => d.toLowerCase().startsWith(head.toLowerCase())).map(d => ({ text: d.slice(head.length), label: d, description: 'words you typed earlier' }))] }
  }).catch(($, e, next) => next(e))

  // the prompt box changed (a key typed there, esc esc): the bar's `rewrite for…` goes once the box no longer holds
  // /rewrite (ui.ts promptHasKeys)
  on('prompt.change', async ($, e, next) => {
    const r = await next(e)
    await promptHasKeys($, String(e.text ?? '')).catch(() => undefined)
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
  // the person's own prompt ends the hint and the wait
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
