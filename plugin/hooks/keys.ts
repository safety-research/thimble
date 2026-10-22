// keys.ts: thimble's keys at an empty prompt, in one hook. A key goes to the first of these that takes it now:
//
//   v        designer/v.ts vKey      a card of the last answer
//   f F p u  bar/fix.ts fixKey       the failure line's keys and the fix line's, while those lines show
//   …        core/answerview.ts restoredKey   the keys of the features that act on answers: the tray's, a large label
//                                    run's ask, the squeeze chips' and s, { } over the answers, the explainers', c, t
//   letters  cards/draw.ts cardTake  the card on screen that lists the key
//   r l      bar/register.ts barKey  coverage and the labels, while the bar names them
//
// Anything no one takes is typed as usual. A card never gets thimble's own keys (ownKeys); the card tool says so.
//
// The word window. Each of these keys is a letter, and a letter also starts a word. So a letter typed within WORD_MS
// after keys thimble took means the person types a word: the keys are undone and the word goes into the box whole, the
// keys first. Each taker says how its key acts: `now`, with an `undo` (a card's key, which must answer at once; v, whose
// fork Claude Code holds until the window closes), or `later`, once the window closed with no letter (a pane or a turn,
// which cannot be undone). A card's own keys typed quickly one after another are not a word: the same card takes each.
//
// Keys that come quickly can arrive as one edit with several letters (a burst): it is taken key by key when each is a
// key of the same card, and typed whole otherwise (a paste is typed whole). Claude Code asks this hook with the box as
// it would be had the keys still waiting for an answer been typed into it: so a box that holds only keys thimble took
// is empty too.
import type { EngineInterface, Register } from 'claude-code'

import { fixKey } from '../bar/fix'
import { failNotice } from '../bar/notice'
import { FIX_KEYS } from '../bar/fixask.js'
import { BAR_KEYS, barKey } from '../bar/register'
import { cardTake } from '../cards/draw'
import { restoredKey, restoredKeys } from '../core/answerview'
import { vKey } from '../designer/v'

type Engine = EngineInterface

/** How long after a key thimble took a letter means the person is typing a word that starts with it. */
export const WORD_MS = 350

/** thimble's own keys at an empty prompt. (Read when asked: the features' modules, which this one imports through
 *  core/answerview.ts, import the card tool, which reads them, so a list made as this module loads would read the
 *  features' keys before their modules set them.) */
export function ownKeys(): string[] {
  return ['v', ...FIX_KEYS, ...restoredKeys(), ...BAR_KEYS]
}

/** How a taker takes a key: `card` (a card's own key: its keys typed quickly are not a word), `now` with its `undo`
 *  (done at once, undone when a letter follows within the word window), or `later` (done once the window closed with
 *  no letter). */
export type Take = { card?: string; now?: () => Promise<unknown>; undo?: () => Promise<unknown>; later?: () => Promise<unknown> }
type Window = { at: number; keys: string; undo: (() => Promise<unknown>)[]; card: string | null; shut: boolean }

/** The keys thimble took last, while their word window may still be open. */
let open: Window | null = null
/** The keys thimble took since the person last typed into the box. */
let taken = ''

const isLetter = (k: string) => /^\p{L}$/u.test(k)
const failed = (key: string, err: unknown) => `The ${key} key did not run: ${String((err as Error)?.message || err).slice(0, 200)}`

/** Who takes the key now, in the order above. */
async function takerOf($: Engine, key: string, until: number): Promise<Take | null> {
  return (await vKey($, key, until)) ?? (await fixKey($, key)) ?? (await restoredKey($, key, until)) ?? (await cardTake($, key)) ?? (await barKey($, key))
}

/** The window still open at `now`, or null. */
const windowAt = (now: number) => (open && !open.shut && now - open.at < WORD_MS ? open : null)

/** A letter typed while a window is open: the person types a word. The window's keys are undone, and its keys are what
 *  goes into the box before the letter; '' when no window is open or the key is no letter. */
async function wordOf(now: number, key: string): Promise<string> {
  const w = windowAt(now)
  if (!w || !isLetter(key)) return ''
  w.shut = true
  open = null
  for (const undo of [...w.undo].reverse()) await undo().catch(() => undefined)
  return w.keys
}

/** One key: taken by thimble (`true`), or what goes into the box for it: the key alone, or a word whose first keys
 *  thimble had taken. */
async function press($: Engine, key: string, now: number): Promise<true | string> {
  const w = windowAt(now)
  let t: Take | null = null
  try {
    t = await takerOf($, key, now + WORD_MS)
  } catch (err) {
    failNotice($, failed(key, err))
  }
  if (w && w.card && t?.card === w.card) {
    w.at = now
    w.keys += key
    if (t.undo) w.undo.push(t.undo)
    taken = (taken + key).slice(-64)
    await t.now?.()
    return true
  }
  const word = await wordOf(now, key)
  if (word) return `${word}${key}`
  if (!t) return key
  const mine: Window = { at: now, keys: key, undo: t.undo ? [t.undo] : [], card: t.card ?? null, shut: false }
  open = mine
  taken = (taken + key).slice(-64)
  await t.now?.()
  const later = t.later
  if (later) $.clock.after(WORD_MS, () => { if (!mine.shut) void later().catch(err => failNotice($, failed(key, err))) })
  return true
}

/** A burst of keys in one edit: taken key by key when each is a key of one card, else typed whole. */
async function burst($: Engine, keys: string[], now: number): Promise<true | string> {
  const owners = await Promise.all(keys.map(k => cardTake($, k).catch(() => null)))
  if (owners.every(o => o && o.card === owners[0]!.card)) {
    let typed = ''
    for (const key of keys) {
      if (typed) typed += key
      else { const r = await press($, key, now); if (r !== true) typed = r }
    }
    return typed || true
  }
  return `${await wordOf(now, keys[0]!)}${keys.join('')}`
}

export const registerKeys: Register = on => {
  on('prompt.edit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    // the box holds what the person typed: every key types
    if (e.text !== '' && !(taken && taken.endsWith(e.text))) {
      taken = ''
      open = null
      return next(e)
    }
    // the box shows empty: an edit applies to the empty box
    const empty = { ...e, text: '', cursor: 0, start: 0, end: 0 }
    const k = e.key
    if ((k && (k.ctrl || k.meta || [...k.key].length !== 1)) || !e.inputText) return next(empty)
    const now = Number(await $.clock.now())
    const r = k ? await press($, k.key, now) : await burst($, [...e.inputText], now)
    if (r === true) return { text: '', cursor: 0 }
    taken = ''
    if (!e.text && r === e.inputText) return next(e)
    // a word whose first keys thimble had taken, or keys typed into a box that shows empty
    return { text: r, cursor: r.length }
  }).catch(($, e, next) => next(e))
}
