// fit.ts: a card that does not fit on the analyst's screen shows once the card check has read it, as the check's
// replacement. The card tool (tool.ts) measures each version as the runner lays it out at the card's width: more rows
// than its frame shows (draw.ts CARD_ROWS, rowsCut), or lines wider than the card, cut at its edge, do not fit. No model
// takes part in the measure. A version that fits draws at once. One that does not is held (CardMeta.held): its frame
// draws its title and `drawing…` (client.tsx) in place of the card, and it takes no keys. One model call, the card check
// (prompts/card-check.md, the criteria of the workbench's card check that a card of the terminal has, with the one for
// a card that does not fit), reads the analyst's question (for a thread's fork's card, the question asked in that
// thread: threads/seam.ts threadQuestion), the card's title, columns, first row, text copy and view, by the card guide
// (tool.ts cardGuide) and the guidance's `## Cards` (guidance/guidance.ts cardsGuidance), and writes the view, and the
// title, that replace it. tool.ts draws the replacement in the card's place (personVersion), and the card shows when the
// check ends (shown): as the replacement, whatever its size, its first CARD_ROWS rows and `+N rows` under them when it
// still does not fit, or as it stands when the check wrote none or it did not draw. A newer version Claude drew since
// waits for its own check. The card tool's answer says nothing of it: Claude reads what it read before. A card a resumed
// session finds held draws as it stands (store.ts restoreCards).
import type { EngineInterface } from 'claude-code'

import { modelWhy } from '../core/why.js'
import { cardsGuidance } from '../guidance/guidance'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { tracked } from '../telemetry/telemetry'
import { rowsCut } from './draw'
import { type CardMeta, metaOf, saveMeta } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const MODEL = { model: 'opus', effort: 'low', maxTokens: 8000, timeoutMs: 180000 }

/** Whether a version `lines` rows tall at the card's width, `cut` of them cut at its edge, fits: its frame shows it
 *  whole and no line is cut. */
export function fits(lines: number, cut: number): boolean {
  return !rowsCut(lines) && !cut
}

/** A field of the check's answer, `<name>…</name>`, its view without a code fence around it; '' when it gives none. */
function field(text: string, name: string): string {
  const m = new RegExp(`<${name}>\\s*\\n?([\\s\\S]*?)\\n?\\s*</${name}>`, 'i').exec(text)
  return m ? m[1]!.replace(/^\s*```(?:js|javascript)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim() : ''
}

/** The card check of a version that does not fit: one model call over the analyst's question and the card as drawn,
 *  its text copy `copy` `width` columns wide (tool.ts copyText). {view, title}, each '' when the check keeps it, or
 *  {why} when the call failed. */
export async function checkCard($: Engine, o: { id: string; title: string; question: string; columns: string[]; first: string; copy: string[]; width: number; view: string; guide: string }): Promise<{ view: string; title: string; why?: string }> {
  let system = ''
  try {
    system = fill(await promptText($, 'card-check'), { GUIDE: o.guide, GUIDANCE: await cardsGuidance($) })
  } catch (err) {
    return { view: '', title: '', why: `its text could not be read (${String((err as Error)?.message || err).slice(0, 120)})` }
  }
  const prompt = [
    `The analyst's question: ${o.question.trim().slice(0, 2000) || '(not known)'}`,
    '',
    `<card id="${o.id}">`,
    `<title>${o.title}</title>`,
    `<columns>${o.columns.join(', ')}</columns>`,
    `<first-row>${o.first}</first-row>`,
    `<draws width="${o.width}">`, ...o.copy, '</draws>',
    '<view>', o.view.trim(), '</view>',
    '</card>',
  ].join('\n')
  const req = { ...MODEL, system: [{ text: system, cache: true }], prompt }
  let r: Any
  try {
    r = await tracked($, { feature: 'cards', prompt: 'card-check', model: req.model, doing: `checking “${o.title.length > 40 ? `${o.title.slice(0, 39)}…` : o.title}”` }, () => $.model.complete(req as Any))
  } catch (err) {
    r = { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
  if (!r?.isAnswered) return { view: '', title: '', why: modelWhy(r) || 'the model wrote no text' }
  const text = String(r.text ?? '')
  return { view: field(text, 'view'), title: field(text, 'title').replace(/\s+/g, ' ') }
}

/** The check of card `id` ended, at its version `version`: a card held as that version shows as it stands, and a
 *  newer version waits for its own check. Whether it showed. */
export async function shown($: Engine, id: string, version: number): Promise<boolean> {
  const meta = await metaOf($, id)
  if (!meta?.held || meta.version !== version) return false
  await saveMeta($, { ...meta, held: null } as CardMeta)
  $.ui.invalidate('ui.render')
  return true
}
