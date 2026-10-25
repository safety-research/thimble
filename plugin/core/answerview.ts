// answerview.ts: the one place where the features that act on Claude's answers (squeeze and catch-up, the explainers
// and heads-ups, the claims, the side threads, the tray, the label rows and the ask before a large label run) draw on
// the screen and take keys. Each host calls one function here, and this calls each feature's seam by name (Claude Code
// follows `$` only into functions a file declares or imports, so a list of handlers that take `$` cannot be called):
//
//   marks/register.ts  AssistantMessage   textView (the text a row shows), rowDrawing (a row a feature draws whole: a
//                                         catch-up), spansFor (explainers and heads-ups on its words), markFocus (the
//                                         citation the tray shows), underText (lines under the row's words),
//                                         markPressed (a press on a citation), passagesFor (what the margin of
//                                         each passage asks: a side thread about it)
//   registerAnswerView AssistantMessage   underAll: lines under a row after the cards drawn under it (the chips)
//   cards/draw.ts      a card's frame     underCard: lines under one card (its label row); cardAsk (what its
//                                         margin asks: a side thread about it)
//   bar/register.ts    AbovePrompt        aboveBar: what stands above the bar (the tray), in the rows the
//                                         band has left over the bar
//   bar/bar.tsx        the bar            barLeft, barRight: the features' items, in the bar's order (`e explain`,
//                                         `c cite`)
//   hooks/keys.ts      prompt.edit        restoredKey: the features' keys, in their order; restoredKeys() are letters
//                                         no card may take
//   core/pane.ts       the side pane      the kinds `claims`, `threads` and `thread` (the seams' draws)
//
// Every function here answers what the seams give, checked, and nothing when a seam throws: a feature's failure never
// takes the answer, the bar or a key with it.
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { CLAIMS_KEYS, claimsBar, claimsKey } from '../claims/seam'
import { EXPLAIN_KEYS, explainBar, explainKey, explainSpans } from '../explain/seam'
import type { Take } from '../hooks/keys'
import { labelsUnderAnswer, labelsUnderCard } from '../labels/use'
import { citeBar, citeKey, citeShown } from '../marks/cite'
import { SQUEEZE_KEYS, squeezeBar, squeezeHidesCard, squeezeHolds, squeezeKey, squeezeRow, squeezeUnder, squeezeUnderCard, squeezeView } from '../squeeze/seam'
import { THREADS_KEYS, threadOnCard, threadPassages, threadsBar, threadsKey } from '../threads/seam'
import { markPressed as trayMarkPressed, trayBand, trayBar, trayFocus, trayHolds, trayKey } from '../tray/seam'
import { answerStepKey, pickedRow } from './answers'
import { askOnce } from './rowhook'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** What a row of Claude's shows in place of the words Claude wrote (squeeze/seam.ts squeezeView). `text`: the words
 *  shown (null: Claude's own); `hidden`: the row draws nothing (a catch-up covers it); `dim`: drawn dim (a rewrite
 *  runs). */
export type TextView = { text?: string | null; hidden?: boolean; dim?: boolean }

/** How a span of a row's words is drawn: the props of its Text. */
/** A span's look: Text's props, `tint`, the background it takes inside a citation's words (which keep the
 *  citation's color and underline), and `hoverBg`, the fill behind all of it while the pointer is over any piece of it
 *  (marks/view.ts spanEl: one hover group per span). */
export type SpanLook = { color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean; underline?: boolean; tint?: string; hoverBg?: string }

/** Words of a row drawn as a press of a feature's (explain/seam.ts explainSpans): [start, end) are offsets into the
 *  text the row shows, on plain words (a citation's words inside it, or around it, are drawn with the citation, whose
 *  press they keep). `id` names it to the tray (MarkRef); `focus`: how it looks while the tray shows it. */
export type Span = { id: string; start: number; end: number; look: SpanLook; focus?: SpanLook; label: string; onPress?: () => unknown }

/** A mark of a row, as the tray and the explainers name it: a citation by its number in the reply (marks/store.ts
 *  MarkItem.n), or an explainer's or a heads-up's span by its id. */
export type MarkRef = { row: string; kind: 'citation'; n: number } | { row: string; kind: 'explain' | 'heads'; id: string }

/** The letters the features take at an empty prompt, which no card may take. (Read when asked: the features' seams
 *  import modules that come back here through the card tool, so a list made as this module loads could read a seam's
 *  keys before its module set them.) */
export function restoredKeys(): string[] {
  return [...SQUEEZE_KEYS, ...EXPLAIN_KEYS, ...CLAIMS_KEYS, ...THREADS_KEYS]
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
 * citation's link syntax; one that overlaps an earlier one is left out. The span the tray shows (`focus`, its id) has
 * its focus look. In order of their start.
 */
export function checkSpans(given: unknown, text: string, marks: { start: number; end: number; words: string }[], focus: string | null): Span[] {
  const out: Span[] = []
  for (const s of Array.isArray(given) ? (given as Span[]) : []) {
    if (!s || typeof s.id !== 'string' || !(s.start >= 0) || !(s.end > s.start) || s.end > text.length) continue
    const inside = marks.find(m => s.start >= m.start + 1 && s.end <= m.start + 1 + m.words.length)
    const crosses = !inside && marks.some(m => s.start < m.end && s.end > m.start && !(s.start <= m.start && s.end >= m.end))
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
export async function rowDrawing($: Engine, els: Any, row: string, cols: number, cardsIn?: (text: string, rows: string[]) => Promise<Record<string, Any>>): Promise<Any | null> {
  return safe(squeezeRow($, els, row, cols, cardsIn), null)
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

/** What stands above the bar: the tray while it is open. `room`: the rows it may take, so the bar under it stays on
 *  screen (0: no limit). */
export async function aboveBar($: Engine, els: Any, width: number, room = 0): Promise<Any[]> {
  return els0(await safe(trayBand($, els, width, room > 0 ? Math.max(1, room) : 0), []))
}

/** A seam's bar items, checked; in the settings pane's preview none is a press. */
const items = (xs: unknown, preview: boolean): BarItem[] => (Array.isArray(xs) ? xs : [])
  .filter((x): x is BarItem => !!x && typeof x.id === 'string' && typeof x.words === 'string')
  .map(x => (preview ? { id: x.id, words: x.words, ...(x.key ? { key: x.key } : {}), ...(x.glyph ? { glyph: x.glyph } : {}), ...(x.focus ? { focus: true } : {}) } : x))

/** The features' items at the bar's left, after v: the tray's steps, s, b, e, then c cite. While an item of
 *  what holds the keys shows (`focus`: the open tray's keys, the open chips'), the left names only those. */
export async function barLeft($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  const tray = items(await safe(trayBar($, on, preview), []), preview)
  // while the tray holds the keys (its own in its header), the open chips' keys (0 [ ]) wait: each key shows once
  const holds = tray.length > 0 || (!preview && (await safe(trayHolds($), false)))
  return [
    ...tray,
    ...items(await safe(squeezeBar($, on, preview), []), preview).filter(x => !(holds && x.focus)),
    ...items(await safe(explainBar($, on, preview), []), preview),
    ...items(await safe(citeBar($, on, preview), []), preview),
  ]
}

/** The features' items at the bar's right, before coverage and the labels: what holds for the whole session, the
 *  claims and the side threads (the left names what acts on an answer). While c cites the selected words (`c cite` at
 *  the left), the claims' item shows without its key, so each key is named once. */
export async function barRight($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  const citing = preview ? on('cite') : await safe(citeShown($), false)
  const claims = items(await safe(claimsBar($, on, preview), []), preview)
  return [
    ...(citing ? claims.map(({ key: _key, ...x }) => x) : claims),
    ...items(await safe(threadsBar($, on, preview), []), preview),
  ]
}

/** A key at an empty prompt, to the first feature that takes it now: the tray while open (a press on a citation
 *  opens it over the chips, and 0 closes it), the squeeze chips while open (their keys came first in 0.10 too), the
 *  tray's ] [ at rest, s, { } over the answers, e, c (cite while words wait, else the claims), then t. */
export async function restoredKey($: Engine, key: string, until: number): Promise<Take | null> {
  const tray = await safe(trayHolds($), false)
  const chips = await safe(squeezeHolds($), false)
  return (tray ? await safe(trayKey($, key, until), null) : null)
    ?? (chips ? await safe(squeezeKey($, key, until), null) : null)
    ?? (tray ? null : await safe(trayKey($, key, until), null))
    ?? (await safe(squeezeKey($, key, until), null))
    ?? (await safe(answerStepKey($, key), null))
    ?? (await safe(explainKey($, key, until), null))
    ?? (await safe(citeKey($, key, until), null))
    ?? (await safe(claimsKey($, key, until), null))
    ?? (await safe(threadsKey($, key, until), null))
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
      const tail = await underAll($, els, e.requestId, Math.max(20, (e.viewport?.columns ?? 100) - 3))
      return tail.length ? els.Box({ flexDirection: 'column', children: [r, ...tail] }) : r
    } catch {
      return below()
    }
  }).catch(($, e, next) => next(e))
}
