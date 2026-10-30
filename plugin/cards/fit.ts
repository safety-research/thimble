// fit.ts: a card that does not fit on the analyst's screen gets a critique and a new version before the analyst sees it.
// The card tool (tool.ts) measures each version as the runner lays it out at the card's width: more rows than its frame
// shows (draw.ts CARD_ROWS, rowsCut), or lines wider than the card, cut at its edge, do not fit. Such a version is held
// (CardMeta.held): its frame draws its title and `drawing…` (client.tsx) in place of the card, and it takes no keys.
// One model call (prompts/card-critique.md) reads the analyst's question (for a thread's fork's card, the question
// asked in that thread: threads/seam.ts threadQuestion), the card's title and text copy, and the guidance's `## Cards`
// (guidance/guidance.ts cardsGuidance), and says what the card shows beyond what its question needs; the call's answer
// carries it, so Claude draws the next version with the card's `id` and `edits`. The answer gives no measure of the
// version: the analyst never saw it, so there is nothing of it to tell them. A version that fits draws at once. After
// MAX_TRIES new versions that do not fit, the version that comes closest draws: its first CARD_ROWS rows and `+N rows`
// under them. A card still held when the turn that drew it ends draws as it stands (register.ts, releaseHeld), and so
// does one a resumed session finds held (store.ts restoreCards).
import type { EngineInterface } from 'claude-code'

import { modelWhy } from '../core/why.js'
import { cardsGuidance } from '../guidance/guidance'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { tracked } from '../telemetry/telemetry'
import { CARD_ROWS, rowsCut } from './draw'
import { type CardMeta, metaOf, saveMeta } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** New versions a card that does not fit gets before the version that comes closest draws with its cut-off. */
export const MAX_TRIES = 2
const COPY_LINES = 80 // of the card's text copy the critique reads
const MODEL = { model: 'opus', effort: 'low', maxTokens: 2000, timeoutMs: 120000 }
const HELD = { plugin: 'thimble', key: 'cardsHeld' } as const

/** A version as the runner laid it out: its rows and its lines cut at the card's width. */
export type Size = { rows: number; cut: number; fits: boolean; excess: number }

/** The size of a version `lines` rows tall at the card's width, `cut` of them cut at its edge: it fits when its frame
 *  shows it whole and no line is cut. `excess`, how far past both limits it draws, picks the version that comes
 *  closest. */
export function sizeOf(lines: number, cut: number): Size {
  const over = rowsCut(lines) ? lines / CARD_ROWS - 1 : 0
  return { rows: lines, cut, fits: !rowsCut(lines) && !cut, excess: over + (lines ? cut / lines : 0) }
}

/** What the critique reads of where a version runs past what the analyst sees at once, besides its copy, which shows
 *  its rows: lines wider than the card, '' for none. No measure: the critique goes to Claude, who needs what the card
 *  shows beyond its question, not how large it is. */
export function sizeWhere(s: Size): string {
  return s.cut ? 'Some of its lines are wider than the card.' : ''
}

/** The critique of a version that does not fit: one model call over the analyst's question, the card's title and its
 *  text copy, held to the guidance's `## Cards`. {text}, or {why} when the call gave none. */
export async function critique($: Engine, o: { title: string; question: string; lines: string[]; size: Size; width: number }): Promise<{ text: string; why: string }> {
  let system = ''
  try {
    system = fill(await promptText($, 'card-critique'), { GUIDANCE: await cardsGuidance($) })
  } catch (err) {
    return { text: '', why: `its text could not be read (${String((err as Error)?.message || err).slice(0, 120)})` }
  }
  const copy = o.lines.slice(0, COPY_LINES)
  const prompt = [
    `The analyst's question: ${o.question.trim().slice(0, 2000) || '(not known)'}`,
    '',
    `The card's title: ${o.title}`,
    ...(sizeWhere(o.size) ? [sizeWhere(o.size)] : []),
    '',
    `What it draws, ${o.width} columns wide:`,
    '<card>', ...copy, ...(o.lines.length > copy.length ? [`(${o.lines.length - copy.length} more lines)`] : []), '</card>',
  ].join('\n')
  const req = { ...MODEL, system: [{ text: system, cache: true }], prompt }
  let r: Any
  try {
    r = await tracked($, { feature: 'cards', prompt: 'card-critique', model: req.model, doing: `reading “${o.title.length > 40 ? `${o.title.slice(0, 39)}…` : o.title}”` }, () => $.model.complete(req as Any))
  } catch (err) {
    r = { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
  const text = r?.isAnswered ? String(r.text ?? '').replace(/\s+/g, ' ').trim() : ''
  return text ? { text, why: '' } : { text: '', why: modelWhy(r) || 'the model wrote no text' }
}

// ------------------------------------------------------------------------------------------------- held cards

/** The cards that wait for a version that fits, oldest first. */
export async function heldNow($: Engine): Promise<string[]> {
  return ((await $.state.get(HELD)).value ?? []) as string[]
}

/** Card `id` among the held cards, or no longer. */
export async function noteHeld($: Engine, id: string, held: boolean): Promise<void> {
  const now = await heldNow($)
  if (held === now.includes(id)) return
  await $.state.set(HELD, held ? [...now, id] : now.filter(x => x !== id))
}

/** The turn that drew them ended (main's, `agentId` null, or a fork's): each card it holds draws as it stands, since no
 *  version that fits comes for it now. The cards drawn. */
export async function releaseHeld($: Engine, agentId: string | null): Promise<string[]> {
  const out: string[] = []
  for (const id of await heldNow($)) {
    const meta = await metaOf($, id)
    if (meta && (meta.agentId ?? null) !== agentId) continue
    if (meta?.held) await saveMeta($, { ...meta, held: null } as CardMeta)
    await noteHeld($, id, false)
    out.push(id)
  }
  if (out.length) $.ui.invalidate('ui.render')
  return out
}
