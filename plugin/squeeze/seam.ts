// seam.ts: where Squeeze and Catch-up (two settings) meet the rest of thimble (core/answerview.ts calls each function by name, since
// Claude Code follows `$` only into functions a file declares or imports). The feature's own modules are beside this
// file: term.ts (the records, the rewrite, the catch-up, what Claude hears), ui.ts (the chips, their keys, the bar, the
// drawing), cards.ts (the cards a squeeze changes), chips.mjs (pure: the chips, the request, the reply, the checks),
// chips.tsx (the chips' Client), prompts/squeeze.md.
//
//   SQUEEZE_KEYS                       its letters at an empty prompt, which no card may take (hooks/keys.ts ownKeys)
//   squeezeView($, row, text)          the text a row of Claude's shows now in place of what Claude wrote: a version
//                                      the person squeezed or stretched, the part of it written in so far, `dim` while
//                                      a rewrite runs; null: the row as Claude wrote it
//   squeezeUnder($, els, row, cols, cardsIn)  what stands under the row after its cards: the catch-up of the replies
//                                      it ends (the rule down its side, its head line, its words with their marks, the
//                                      replies' explainers and the cards it places), why a catch-up failed, what a
//                                      squeeze left out of its cards, the chips while they are open on it
//   squeezeUnderCard($, els, id, cols) what stands under one card: what a squeeze changed of it
//   squeezeHidesCard($, id)            whether a card is left out of the version of its answer shown now
//   squeezeHolds($)                    whether the chips are open: their keys come before the tray's and the ask's
//   squeezeKey($, key, until)          s (and the chips' keys while they are open): a taker as hooks/keys.ts takes it
//   squeezeBar($, on, preview)         its items at the bar's left (`s rewrite`, `b catch up on N replies`; the
//                                      chips' keys while they are open)
//   registerSqueeze                    its own hooks: /rewrite (what + writes in the prompt box, hidden from the
//                                      typeahead) and its autocomplete, the chips' Client, the prompt that carries the
//                                      version told to Claude, a resumed session's cards
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { TextView } from '../core/answerview'
import type { Take } from '../hooks/keys'
import { featureOn } from '../settings/features.mjs'
import { restoreCardsShown } from './cards'
import { ownWords } from './chips.mjs'
import { promptSent, recOf } from './term'
import { addOwn, barItems, type CardsIn, chipsHold, chipsPost, closeChips, hidesCard, openChips, openNow, ownEarlier, promptHasKeys, squeezeKeyTake, targetNow, turnChips, underCardLine, underRow, viewOf } from './ui'

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

export async function squeezeHolds($: Engine): Promise<boolean> {
  return chipsHold($)
}

export async function squeezeKey($: Engine, key: string, _until: number): Promise<Take | null> {
  return squeezeKeyTake($, key)
}

export async function squeezeBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  return barItems($, on, preview)
}

/** A /clear or a /resume (hooks/turnover.ts): the chips close, the person's own chips of the earlier conversation are
 *  not offered, and the cards show the versions the new conversation's squeezes left. */
export async function turnSqueeze($: Engine): Promise<void> {
  await turnChips($)
  await restoreCardsShown($, true)
}

export const registerSqueeze: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    try { await restoreCardsShown($) } catch { /* the cards draw as they stand */ }
    try {
      await $.command.register({ name: 'rewrite', description: 'Rewrite the message the keys act on along a chip in your own words: /rewrite for my manager', argumentHint: '[who or what to rewrite it for]', immediate: true })
    } catch {
      // s at an empty prompt still opens the chips
    }
    return r
  }).catch(($, e, next) => next(e))

  // /rewrite is not a command people type: + in the chips writes it in the prompt box, and the person's words follow it.
  // So the typeahead and /help leave it out; it runs when the box sends it
  on('command.describe', { command: /^(thimble:)?rewrite$/ }, async ($, e, next) => ({ ...(await next(e)), isHidden: true })).catch(($, e, next) => next(e))

  // /rewrite [words]: a chip in the person's own words on the message the chips are open on (else the one the keys act
  // on), picked; with no words, the chips open
  on('command.run', { command: 'rewrite' }, async ($, e) => {
    if (!featureOn('squeezeAnswers')) return { text: 'Rewrite is off. Turn it on in /thimble-settings to use it.' }
    const id = (await openNow($))?.id ?? (await targetNow($))
    if (!id || !(await recOf($, id))) return { text: 'No message to rewrite yet: ask Claude something first.' }
    if (!ownWords(e.args)) { await openChips($, id); return {} }
    await addOwn($, id, e.args)
    return {}
  })

  // what follows /rewrite: the chips typed earlier this session, offered as the words are typed
  on('prompt.autocomplete', async ($, e, next) => {
    const r = await next(e)
    if (!/^\/rewrite\s/.test(e.text) || e.start < 9) return r
    const typed = e.text.slice(9, e.cursor).toLowerCase()
    const hits = (await ownEarlier($)).filter(d => d.toLowerCase().startsWith(typed) && d.toLowerCase() !== typed).reverse().slice(0, 5)
    if (!hits.length) return r
    // a row writes the whole words in place of what follows /rewrite (the token is the last word typed)
    const head = e.text.slice(9, e.start)
    return { suggestions: [...r.suggestions, ...hits.filter(d => d.toLowerCase().startsWith(head.toLowerCase())).map(d => ({ text: d.slice(head.length), label: d, description: 'a chip you typed earlier' }))] }
  }).catch(($, e, next) => next(e))

  // the prompt box changed (a key typed there, esc esc): the chips let go of words begun after + (ui.ts promptHasKeys)
  on('prompt.change', async ($, e, next) => {
    const r = await next(e)
    await promptHasKeys($, String(e.text ?? '')).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // the chips' Client posted: a press, or a key while a click gave them the keyboard
  on('ui.message', { element: /^sqchips-/ }, async ($, e) => chipsPost($, String(e.element).slice('sqchips-'.length), e.data))
    .catch(() => ({}))

  // a prompt that carries thimble's report (core/tell.ts): the versions waiting in it are the ones Claude knows now;
  // the person's own prompt closes the chips, as typing did in 0.10
  on('prompt.submit', { origin: { kind: /^(composer|bridge|plugin)$/ } }, async ($, e, next) => {
    const r = await next(e)
    if (e.command || e.isMeta) return r
    try {
      await promptSent($)
      if ((e.origin as { kind?: string } | undefined)?.kind !== 'plugin') await closeChips($)
    } catch {
      // the version is told again with the next prompt
    }
    return r
  }).catch(($, e, next) => next(e))
}
