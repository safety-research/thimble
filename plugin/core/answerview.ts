// answerview.ts: the one place where the features that act on Claude's answers (squeeze and catch-up, the explainers
// and heads-ups, the claims, the side threads, the tray, the label rows and the ask before a large label run) draw on
// the screen and take keys. Each host calls one function here, and this calls each feature's seam by name (Claude Code
// follows `$` only into functions a file declares or imports, so a list of handlers that take `$` cannot be called):
//
//   marks/register.ts  AssistantMessage   textView (the text a row shows), rowDrawing (a row a feature draws whole: a
//                                         catch-up), spansFor (explainers and heads-ups on its words), markFocus (the
//                                         citation the tray shows), underText (lines under the row's words),
//                                         markPressed (a press on a citation)
//   registerAnswerView AssistantMessage   underAll: lines under a row after the cards drawn under it (the chips)
//   cards/draw.ts      a card's frame     underCard: lines under one card (its label row)
//   bar/register.ts    AbovePrompt        aboveBar: what stands above the bar (the tray, the label ask)
//   bar/bar.tsx        the bar            barLeft, barRight: the features' items, in the bar's order
//   hooks/keys.ts      prompt.edit        restoredKey: the features' keys, in their order; RESTORED_KEYS are letters
//                                         no card may take
//   core/pane.ts       the side pane      the kinds `claims`, `threads` and `thread` (the seams' draws)
//
// Every function here answers what the seams give, checked, and nothing when a seam throws: a feature's failure never
// takes the answer, the bar or a key with it.
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { CLAIMS_KEYS, claimsBar, claimsKey } from '../claims/seam'
import { explainKey, explainSpans } from '../explain/seam'
import type { Take } from '../hooks/keys'
import { labelAskBand, labelAskBar, labelAskKey, labelsUnderAnswer, labelsUnderCard } from '../labels/use'
import { SQUEEZE_KEYS, squeezeBar, squeezeHidesCard, squeezeHolds, squeezeKey, squeezeRow, squeezeUnder, squeezeUnderCard, squeezeView } from '../squeeze/seam'
import { THREADS_KEYS, threadsBar, threadsKey } from '../threads/seam'
import { markPressed as trayMarkPressed, trayBand, trayBar, trayFocus, trayKey } from '../tray/seam'
import { answerStepKey, pickedRow } from './answers'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** What a row of Claude's shows in place of the words Claude wrote (squeeze/seam.ts squeezeView). `text`: the words
 *  shown (null: Claude's own); `hidden`: the row draws nothing (a catch-up covers it); `dim`: drawn dim (a rewrite
 *  runs). */
export type TextView = { text?: string | null; hidden?: boolean; dim?: boolean }

/** How a span of a row's words is drawn: the props of its Text. */
export type SpanLook = { color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean; underline?: boolean }

/** Words of a row drawn as a press of a feature's (explain/seam.ts explainSpans): [start, end) are offsets into the
 *  text the row shows, on plain words (a span inside a citation's words is drawn with the citation, whose press it
 *  keeps). `id` names it to the tray (MarkRef); `focus`: how it looks while the tray shows it. */
export type Span = { id: string; start: number; end: number; look: SpanLook; focus?: SpanLook; label: string; onPress?: () => unknown }

/** A mark of a row, as the tray and the explainers name it: a citation by its number in the reply (marks/store.ts
 *  MarkItem.n), or an explainer's or a heads-up's span by its id. */
export type MarkRef = { row: string; kind: 'citation'; n: number } | { row: string; kind: 'explain' | 'heads'; id: string }

/** The letters the features take at an empty prompt, which no card may take. */
export const RESTORED_KEYS = [...SQUEEZE_KEYS, ...CLAIMS_KEYS, ...THREADS_KEYS]

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
 * Spans as drawn: each inside the text, on words that are not a citation's link syntax, either inside one citation's
 * words or outside every citation; one that overlaps an earlier one is left out. The span the tray shows (`focus`, its
 * id) has its focus look. In order of their start.
 */
export function checkSpans(given: unknown, text: string, marks: { start: number; end: number; words: string }[], focus: string | null): Span[] {
  const out: Span[] = []
  for (const s of Array.isArray(given) ? (given as Span[]) : []) {
    if (!s || typeof s.id !== 'string' || !(s.start >= 0) || !(s.end > s.start) || s.end > text.length) continue
    const inside = marks.find(m => s.start >= m.start + 1 && s.end <= m.start + 1 + m.words.length)
    const crosses = !inside && marks.some(m => s.start < m.end && s.end > m.start)
    if (crosses || out.some(o => s.start < o.end && s.end > o.start)) continue
    out.push(focus === s.id && s.focus ? { ...s, look: { ...s.look, ...s.focus } } : s)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The features' spans on a row's words (the explainers and heads-ups), checked (checkSpans). */
export async function spansFor($: Engine, row: string, text: string, marks: { start: number; end: number; words: string }[]): Promise<Span[]> {
  const given = await safe(explainSpans($, row, text, marks), [] as Span[])
  const focus = await safe(trayFocus($, row), null)
  return checkSpans(given, text, marks, focus && focus.kind !== 'citation' ? focus.id : null)
}

/** A row a feature draws whole in place of its words (a catch-up), or null. */
export async function rowDrawing($: Engine, els: Any, row: string, cols: number): Promise<Any | null> {
  return safe(squeezeRow($, els, row, cols), null)
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

/** The lines right under a row's words (and its citations' footer): the labels its turn used. */
export async function underText($: Engine, els: Any, row: string, cols: number): Promise<Any[]> {
  return els0(await safe(labelsUnderAnswer($, els, row, cols), []))
}

/** The lines under a row after the cards drawn under it: the squeeze chips, a catch-up's tail. */
export async function underAll($: Engine, els: Any, row: string, cols: number): Promise<Any[]> {
  return els0(await safe(squeezeUnder($, els, row, cols), []))
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

/** What stands above the bar: the tray while it is open, then a large label run's ask while it waits. */
export async function aboveBar($: Engine, els: Any, width: number): Promise<Any[]> {
  return [...els0(await safe(trayBand($, els, width), [])), ...els0(await safe(labelAskBand($, els, width), []))]
}

/** A seam's bar items, checked; in the settings pane's preview none is a press. */
const items = (xs: unknown, preview: boolean): BarItem[] => (Array.isArray(xs) ? xs : [])
  .filter((x): x is BarItem => !!x && typeof x.id === 'string' && typeof x.words === 'string')
  .map(x => (preview ? { id: x.id, words: x.words, ...(x.key ? { key: x.key } : {}), ...(x.glyph ? { glyph: x.glyph } : {}), ...(x.focus ? { focus: true } : {}) } : x))

/** The features' items at the bar's left, after v: the ask's choices, the tray's steps, s, then c. While an item of
 *  what holds the keys shows (`focus`: the open tray's keys, the open chips'), the left names only those. */
export async function barLeft($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  return [
    ...items(await safe(labelAskBar($, on, preview), []), preview),
    ...items(await safe(trayBar($, on, preview), []), preview),
    ...items(await safe(squeezeBar($, on, preview), []), preview),
    ...items(await safe(claimsBar($, on, preview), []), preview),
  ]
}

/** The features' items at the bar's right, before coverage and the labels: the side threads. */
export async function barRight($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  return items(await safe(threadsBar($, on, preview), []), preview)
}

/** A key at an empty prompt, to the first feature that takes it now: the squeeze chips while open (their keys came
 *  first in 0.10 too), the tray while open (and ] [ at rest), a large label run's ask while it waits, s, { } over the
 *  answers, the explainers' keys, c, then t. */
export async function restoredKey($: Engine, key: string, until: number): Promise<Take | null> {
  const chips = await safe(squeezeHolds($), false)
  return (chips ? await safe(squeezeKey($, key, until), null) : null)
    ?? (await safe(trayKey($, key, until), null))
    ?? (await safe(labelAskKey($, key, until), null))
    ?? (await safe(squeezeKey($, key, until), null))
    ?? (await safe(answerStepKey($, key), null))
    ?? (await safe(explainKey($, key, until), null))
    ?? (await safe(claimsKey($, key, until), null))
    ?? (await safe(threadsKey($, key, until), null))
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerAnswerView: Register = on => {
  // the lines under a row after its cards (cards/register.ts draws the cards; this hook wraps that one)
  on('ui.render', { component: 'AssistantMessage', requestId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.props.isSummary) return r
    const els = $.ui.resolve(e) as Any
    const tail = await underAll($, els, e.requestId, Math.max(20, (e.viewport?.columns ?? 100) - 3))
    return tail.length ? els.Box({ flexDirection: 'column', children: [r, ...tail] }) : r
  }).catch(($, e, next) => next(e))
}
