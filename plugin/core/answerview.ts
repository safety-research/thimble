// answerview.ts: the one place where the features that act on Claude's answers (squeeze and catch-up, the explainers
// and heads-ups, the claims, the side threads, the tray, the label rows and the ask before a large label run) draw on
// the screen and take keys. Each host calls one function here, and this calls each feature's seam by name (Claude Code
// follows `$` only into functions a file declares or imports, so a list of handlers that take `$` cannot be called):
//
//   marks/register.ts  AssistantMessage   textView (the text a row shows), spansFor (explainers and heads-ups on its
//                                         words, the tour's shimmer on the words its step e names), markFocus (the
//                                         citation the tray shows), underText (lines under the row's words),
//                                         markPressed (a press on a citation), passagesFor (what the margin of
//                                         each passage asks: a side thread about it)
//   registerAnswerView AssistantMessage   underAll: lines under a row after the cards drawn under it (the catch-up
//                                         of the replies it ends, the chips); last, the tour's step row (tourUnder)
//   squeeze/ui.ts      a catch-up         spansOver: the explainers and heads-ups of its replies on its words
//   cards/draw.ts      a card's frame     underCard: lines under one card (its label row); cardAsk (what its
//                                         margin asks: a side thread about it)
//   bar/register.ts    AbovePrompt        aboveBar: what stands above the bar (the tray), in the rows the band
//                                         has over the bar; aboveShape: how it was drawn (the band's blank row)
//   bar/bar.tsx        the bar            barLeft, barRight: the features' items, in the bar's order (`c cite`,
//                                         `e explain`, `a ask` while words are selected); heldKeys: the keys what
//                                         holds them takes now, which the bar and a card's header leave unnamed
//                                         (cards/draw.ts too), and selectionAsks: whether a asks about the selected
//                                         words, which a card's header leaves unnamed then
//   hooks/keys.ts      prompt.edit        restoredKey: the features' keys, in their order; restoredKeys() are letters
//                                         no card may take; keysReady, as the plugin loads, what the keys read
//   core/pane.ts       the side pane      the kinds `claims`, `threads` and `thread` (the seams' draws)
//
// Every function here answers what the seams give, checked, and nothing when a seam throws: a feature's failure never
// takes the answer, the bar or a key with it.
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { framesIn, noteFrames } from '../cards/draw'
import { CLAIMS_KEYS, claimsBar, claimsKey, claimsReady } from '../claims/seam'
import { EXPLAIN_KEYS, explainBar, explainKey, explainSpans, explainSpansOf, pendingSpans } from '../explain/seam'
import { fixHeld } from '../fix/line'
import type { Take } from '../hooks/keys'
import { labelsUnderAnswer, labelsUnderCard } from '../labels/use'
import { CITE_KEYS, citeBar, citeKey } from '../marks/cite'
import { featureOn } from '../settings/features.mjs'
import { SQUEEZE_KEYS, squeezeBar, squeezeHidesCard, squeezeKey, squeezeUnder, squeezeUnderCard, squeezeView } from '../squeeze/seam'
import { THREADS_KEYS, askBar, askKey, threadOnCard, threadPassages, threadsBar, threadsKey } from '../threads/seam'
import { tourSpans, tourUnder } from '../tour/tour'
import { markPressed as trayMarkPressed, trayBand, trayBar, trayFocus, trayHeld, trayHolds, trayKey, trayShape, type BandRoom } from '../tray/seam'
import { answerStepKey, pickedRow } from './answers'
import { paneHeld } from './pane'
import { askOnce } from './rowhook'
import { waitsNow } from './selection'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** What a row of Claude's shows in place of the words Claude wrote (squeeze/seam.ts squeezeView). `text`: the words
 *  shown (null: Claude's own); `hidden`: the row draws nothing; `dim`: drawn dim (a rewrite runs). */
export type TextView = { text?: string | null; hidden?: boolean; dim?: boolean }

/** How a span of a row's words is drawn: the props of its Text. */
/** A span's look: Text's props, `tint`, the background it takes inside a citation's words (which keep the
 *  citation's color and underline), and `hoverBg`, the fill behind all of it while the pointer is over any piece of it
 *  (marks/view.ts spanEl: one hover group per span). */
export type SpanLook = { color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean; underline?: boolean; tint?: string; hoverBg?: string }

/** Words of a row drawn as a press of a feature's (explain/seam.ts explainSpans): [start, end) are offsets into the
 *  text the row shows, on plain words (a citation's words inside it, or around it, are drawn with the citation, whose
 *  press they keep). `id` names it to the tray (MarkRef); `focus`: how it looks while the tray shows it; `open`: the
 *  tray shows it (checkSpans), so a plain reply draws it at rest too (marks/view.ts). */
export type Span = { id: string; start: number; end: number; look: SpanLook; focus?: SpanLook; label: string; onPress?: () => unknown; open?: boolean }

/** A mark of a row, as the tray and the explainers name it: a citation by its number in the reply (marks/store.ts
 *  MarkItem.n), or an explainer's or a heads-up's span by its id. */
export type MarkRef = { row: string; kind: 'citation'; n: number } | { row: string; kind: 'explain' | 'heads'; id: string }

/** The letters the features take at an empty prompt, which no card may take. (Read when asked: the features' seams
 *  import modules that come back here through the card tool, so a list made as this module loads could read a seam's
 *  keys before its module set them.) */
export function restoredKeys(): string[] {
  return [...SQUEEZE_KEYS, ...EXPLAIN_KEYS, ...CITE_KEYS, ...CLAIMS_KEYS, ...THREADS_KEYS]
}

const safe = async <T>(p: Promise<T>, none: T): Promise<T> => {
  try { return (await p) ?? none } catch { return none }
}
const els0 = (xs: unknown): Any[] => (Array.isArray(xs) ? xs.filter(x => x != null && x !== false) : [])

// ------------------------------------------------------------------------------------------------ a row's words

/** The text a row shows, whether it draws at all and dim, and the lead of its first line: ▸ when the person picked
 *  this answer for the keys ({ }) over the newest. */
export async function textView($: Engine, row: string, text: string): Promise<{ text: string; hidden: boolean; dim: boolean; lead: string | null }> {
  const v = await safe(squeezeView($, row, text), null)
  const lead = (await safe(pickedRow($), null)) === row ? '▸' : null
  return { text: typeof v?.text === 'string' ? v.text : text, hidden: !!v?.hidden, dim: !!v?.dim, lead }
}

/**
 * Spans as drawn: each inside the text, inside one citation's words or over whole citations, never over part of a
 * citation's link syntax; one that overlaps an earlier one is left out. The span the tray shows (`focus`, its id) is
 * `open`, in its focus look. In order of their start.
 */
export function checkSpans(given: unknown, text: string, marks: { start: number; end: number; words: string }[], focus: string | null): Span[] {
  const out: Span[] = []
  for (const s of Array.isArray(given) ? (given as Span[]) : []) {
    if (!s || typeof s.id !== 'string' || !(s.start >= 0) || !(s.end > s.start) || s.end > text.length) continue
    const inside = marks.find(m => s.start >= m.start + 1 && s.end <= m.start + 1 + m.words.length)
    const crosses = !inside && marks.some(m => s.start < m.end && s.end > m.start && !(s.start <= m.start && s.end >= m.end))
    if (crosses || out.some(o => s.start < o.end && s.end > o.start)) continue
    out.push(focus === s.id ? { ...s, ...(s.focus ? { look: { ...s.look, ...s.focus } } : {}), open: true } : s)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The features' spans on a row's words (the explainers and heads-ups, and first the words being explained on demand,
 *  which cover the marks they overlap; last the tour's shimmer on the words its step e names), checked (checkSpans). */
export async function spansFor($: Engine, row: string, text: string, marks: { start: number; end: number; words: string }[]): Promise<Span[]> {
  const given = [...await safe(pendingSpans($, row, text), [] as Span[]), ...await safe(explainSpans($, row, text, marks), [] as Span[]), ...await safe(tourSpans($, row, text), [] as Span[])]
  const focus = await safe(trayFocus($, row), null)
  return checkSpans(given, text, marks, focus && focus.kind !== 'citation' ? focus.id : null)
}

/** The explainers and heads-ups of the messages `rows` on the words of a text that stands for them (a catch-up),
 *  checked (checkSpans). */
export async function spansOver($: Engine, rows: string[], text: string, marks: { start: number; end: number; words: string }[]): Promise<Span[]> {
  return checkSpans(await safe(explainSpansOf($, rows, text), [] as Span[]), text, marks, null)
}

/** The citation of the row the tray shows (its number in the reply), or null. */
export async function markFocus($: Engine, row: string): Promise<number | null> {
  const f = await safe(trayFocus($, row), null)
  return f && f.kind === 'citation' ? f.n : null
}

/** A press on citation `n` of the row: whether a feature took it (the tray); else its evidence opens. */
export async function markPressed($: Engine, row: string, n: number): Promise<boolean> {
  return safe(trayMarkPressed($, row, n), false)
}

/** What the margin of each passage of a row asks (marks/view.ts passages): a side thread about it; `has` once one was
 *  asked. Null when the threads cannot say. */
export async function passagesFor($: Engine, row: string): Promise<{ has: (p: { text: string; label: string }) => boolean; ask: (p: { text: string; label: string }) => unknown } | null> {
  const p = await safe(threadPassages($, row), null)
  if (!p) return null
  return { has: x => { try { return !!p.has(x) } catch { return false } }, ask: x => { try { return p.ask(x) } catch { return undefined } } }
}

/** What the margin of a card's frame asks: a side thread about the card; with `element`, about a run of its words a
 *  click asked about. Null when the threads cannot say. */
export async function cardAsk($: Engine, id: string, title: string, line = '', element?: { text: string; line: string }): Promise<{ label: string; has: boolean; press: () => unknown } | null> {
  const a = await safe(threadOnCard($, id, title, line, element), null)
  return a && typeof a.label === 'string' && typeof a.press === 'function' ? { label: a.label, has: !!a.has, press: a.press } : null
}

/** The lines right under a row's words (and its citations' footer): the labels its turn used. */
export async function underText($: Engine, els: Any, row: string, cols: number): Promise<Any[]> {
  return els0(await safe(labelsUnderAnswer($, els, row, cols), []))
}

/** The lines under a row after the cards drawn under it: the catch-up of the replies it ends, or its simpler version.
 *  `cardsIn`: the frames of the cards a text places on lines of its own (cards/draw.ts framesIn). */
export async function underAll($: Engine, els: Any, row: string, cols: number, cardsIn?: (text: string, rows: string[], o?: { indent?: number }) => Promise<Record<string, Any>>): Promise<Any[]> {
  return els0(await safe(squeezeUnder($, els, row, cols, cardsIn), []))
}

/** Whether a card is left out of what its answer shows now (a squeeze's version that leaves it out): its frame draws
 *  nothing then. */
export async function cardHidden($: Engine, id: string): Promise<boolean> {
  return safe(squeezeHidesCard($, id), false)
}

/** The lines under one card's frame: what a squeeze changed of it, the labels it used. */
export async function underCard($: Engine, els: Any, id: string, cols: number): Promise<Any[]> {
  return [...els0(await safe(squeezeUnderCard($, els, id, cols), [])), ...els0(await safe(labelsUnderCard($, els, id, cols), []))]
}

// ------------------------------------------------------------------------------------------------ above the prompt

/** What stands above the bar: the tray while it is open. `room`: the rows the band has for it (tray/tray.ts BandRoom),
 *  those over the bar; null: no limit. */
export async function aboveBar($: Engine, els: Any, width: number, room: BandRoom | null = null): Promise<Any[]> {
  return els0(await safe(trayBand($, els, width, room), []))
}

/** What stands above the bar as last drawn: whether the band's blank row stands between it and the bar (`gap`; a
 *  tray that does not fit with it takes it). */
export function aboveShape(): { gap: boolean } {
  try { return trayShape() } catch { return { gap: true } }
}

/** The keys taken now by what holds them and names them in its own place, which every other surface leaves unnamed,
 *  so each key shows once, where it acts. In the order a key at an empty prompt reaches them (hooks/keys.ts): the line
 *  of a fix (fix/line.ts fixHeld), the open tray's, or a card's ] reached (tray/seam.ts trayHeld); and the close the
 *  side pane's key row names (core/pane.ts paneHeld). `ask`: the keys asked about, when not all. Read from the state, so a
 *  drawing that asks draws again when what holds the keys changes. */
export async function heldKeys($: Engine, ask?: string[]): Promise<Set<string>> {
  return new Set([
    ...(await safe(fixHeld($), [] as string[])),
    ...(await safe(trayHeld($, ask), [] as string[])),
    ...(await safe(paneHeld($), [] as string[])),
  ])
}

/** Whether an item's key is free of what holds the keys (`held`, heldKeys): an item with no key always is; a key of
 *  several (`j k`) is free when each is. */
export const keyFree = (held: Set<string>) => (x: { key?: string }): boolean => !x.key || (!held.has('*') && !x.key.split(' ').some(k => held.has(k)))

/** A seam's bar items, checked; in the settings pane's preview none is a press. */
const items = (xs: unknown, preview: boolean): BarItem[] => (Array.isArray(xs) ? xs : [])
  .filter((x): x is BarItem => !!x && typeof x.id === 'string' && typeof x.words === 'string')
  .map(x => (preview ? { id: x.id, words: x.words, ...(x.key ? { key: x.key } : {}), ...(x.glyph ? { glyph: x.glyph } : {}), ...(x.focus ? { focus: true } : {}), ...(x.color ? { color: x.color } : {}) } : x))

/** The features' items at the bar's left, after v: s right after it (its feature acts on the answer, as v does), b,
 *  the tray's steps (at rest its ]), then the keys that act on the selected words, each in its color while words are
 *  selected: c cite (purple), e explain (teal), a ask (blue).
 *  While an item of what holds the keys shows (`focus`: the keys of a card ] reached), the left names only those, after
 *  v and s (bar/bar.tsx leftItems). An
 *  item whose key what holds the keys takes now (`held`, heldKeys: the open tray's keys are in its header) is left
 *  out: each key shows once, where it acts. */
export async function barLeft($: Engine, on: (key: string) => boolean, preview: boolean, held?: Set<string>): Promise<BarItem[]> {
  const tray = items(await safe(trayBar($, on, preview), []), preview)
  const free = keyFree(preview ? new Set() : held ?? (await heldKeys($)))
  return [
    ...items(await safe(squeezeBar($, on, preview), []), preview).filter(free),
    // the keys of a card ] reached are the tray's own
    ...tray.filter(x => x.focus || free(x)),
    ...items(await safe(citeBar($, on, preview), []), preview).filter(free),
    ...items(await safe(explainBar($, on, preview), []), preview).filter(free),
    ...items(await safe(askBar($, on, preview), []), preview).filter(free),
  ]
}

/** Whether a at an empty prompt asks about the selected words now (threads/seam.ts askKey), which reaches it before a
 *  card's header does: the header leaves its a unnamed then (cards/draw.ts). */
export async function selectionAsks($: Engine): Promise<boolean> {
  return safe(waitsNow($, 'ask'), false)
}

/** An item of the bar's right while what holds the keys (`held`, heldKeys) takes its key: the item stays, what holds for
 *  the whole session, a click without its letter, since the key acts where what holds it names it. */
export const unlettered = (held: Set<string>) => <T extends { key?: string }>(x: T): T => {
  if (keyFree(held)(x)) return x
  const { key: _key, ...rest } = x
  return rest as T
}

/** The features' items at the bar's right, before coverage and the labels: what holds for the whole session, the
 *  claims and the side threads (the left names what acts on an answer), each without its letter while what holds the
 *  keys takes its key (`held`, as barLeft; unlettered). */
export async function barRight($: Engine, on: (key: string) => boolean, preview: boolean, held?: Set<string>): Promise<BarItem[]> {
  const letter = unlettered(preview ? new Set<string>() : held ?? (await heldKeys($)))
  return [
    ...items(await safe(claimsBar($, on, preview), []), preview).map(letter),
    ...items(await safe(threadsBar($, on, preview), []), preview).map(letter),
  ]
}

/** A key at an empty prompt, to the first feature that takes it now: the tray (while open its own keys, 0 closes it;
 *  at rest ] [), s and b and the keys of the row under a simpler version (1–4, 0), { } over the answers, then the
 *  keys that act on the selected words, while they wait (else typed): e, c and a; then w (the claims), then t. */
export async function restoredKey($: Engine, key: string, until: number): Promise<Take | null> {
  return (await safe(trayKey($, key, until), null))
    ?? (await safe(squeezeKey($, key, until), null))
    ?? (await safe(answerStepKey($, key), null))
    ?? (await safe(explainKey($, key, until), null))
    ?? (await safe(citeKey($, key, until), null))
    ?? (await safe(askKey($, key, until), null))
    ?? (await safe(claimsKey($, key, until), null))
    ?? (await safe(threadsKey($, key, until), null))
}

/** What the features' keys read of the state (whether the tray holds the keys, whether the bar
 *  names w), read as the plugin loads: each load starts with nothing kept (a change in the settings loads it again), and
 *  the first key would read it inside the few milliseconds Claude Code gives the key's hook. */
export async function keysReady($: Engine): Promise<void> {
  await safe(trayHolds($), false)
  await safe(claimsReady($), undefined)
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerAnswerView: Register = on => {
  // the lines under a row after its cards (cards/register.ts draws the cards; this hook wraps that one)
  // (fails safe, core/rowhook.ts: a throw here leaves the answer and its cards as drawn beneath)
  on('ui.render', { component: 'AssistantMessage', requestId: /\S/ }, async ($, e, next) => {
    const below = askOnce(e, next)
    try {
      const r = await below()
      if (e.props.isSummary) return r
      const els = $.ui.resolve(e) as Any
      const cols = Math.max(20, (e.viewport?.columns ?? 100) - 3)
      const tail = await underAll($, els, e.requestId, cols, async (t, rows, o) => (featureOn('cards') ? framesIn($, e, t, rows, o) : {}))
      // last, under all that thimble draws under the answer: the tour's step row, when the answer is its sample answer
      const step = await safe(tourUnder($, e), null)
      if (step) tail.push(step)
      const drawn = tail.length ? els.Box({ flexDirection: 'column', children: [r, ...tail] }) : r
      // where the row's cards stand in it, so a card's keys go to it only while the screen shows it
      if (featureOn('cards')) noteFrames($, drawn, cols, e.props?.onScreen)
      return drawn
    } catch {
      return below()
    }
  }).catch(($, e, next) => next(e))
}
