// selection.ts: the words the analyst selected with the mouse that e (explain/seam.ts) and c (marks/cite.ts) act on:
// words of Claude's answers only. Claude Code answers the last selection ($.ui.selection, fullscreen layout only) until
// the person selects again, dismisses it, or sends their next prompt, wherever it was made; so a selection in thimble's
// pane (a setting's name) or the prompt is none of theirs, and one the pane held is dropped when the pane closes.
//
// A line of the selection is an answer's when its words stand in the words of one of Claude's text rows, compared word
// by word (runs of letters and digits: a table's borders, a list's bullet, a link's brackets and the signs after a
// citation are no words), and it holds one of them whole (a piece of one word, as a click that slid a cell leaves, `im`
// of the bar's `thimble`, is none):
//   - in a row (Claude Code names the row a selection lies in): one of Claude's text rows, as it draws its words (as
//     Claude wrote them, a link's words and its target, the version shown in their place: a rewrite, corrected
//     citations; shownWords), and the selection's first and last words may be cut where the drag began and ended. A
//     row of Claude Code's own (a tool call, the turn's time, the person's prompt) holds no answer's words
//   - in no row (a drag across rows, or outside the transcript: the bar, a pane, the prompt): any of Claude's text
//     rows. Across rows, the first line may start inside a word and the last end inside one; a line alone, outside the
//     transcript, stands there whole (a piece of the prompt's suggestion or of Claude Code's busy word is none)
// and words that are, whole, those of one of thimble's own controls (controlWords: a double click on the chips'
// `longer` selects that word) are none.
//
//   answerSelection($)   the selection's words that lie in Claude's answers, a line at a time: a drag that starts on a
//                        row of Claude Code's own (`Ran 3 shell commands`, the answer's ● dot) keeps the answer's lines;
//                        undefined when no line is an answer's (answerSelectionOf: of a selection read before)
//   selectionNow($), selectionKey(sel)   Claude Code's selection as it answers it, and what tells one selection from
//                        another ('' for none)
//   dropSelection($)     the pane closes: a selection outside the transcript (the pane's) is dropped
//   selectionUsed($, by, sel), usedBy($, by, sel)   e or c took this selection, so the bar stops naming that key
//                        for it until words are selected anew
//   shownWords(row, raw, text)   the words a row of Claude's draws now in place of the ones it holds (`raw`;
//                        marks/register.ts), kept in memory
//   controlWords(at, words) the words of thimble's own controls drawn now `at` the bar, a card's header, the chips or
//                        the tray, kept in memory until that place draws again
//
// state: selectionDone, the selection dropped and the ones e and c took, by row and words: kept across the plugin's
// loads, since a change in the settings loads it again while the same selection stands
import type { EngineInterface } from 'claude-code'

import { rewritesIn, withAsked, withCorrections, withoutLinks } from '../marks/message.js'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageOf, textRows } from './answers'

type Engine = EngineInterface
export type Sel = { text: string; requestId?: string }

const DONE = { plugin: 'thimble', key: 'selectionDone' } as const
type Done = { dropped?: string; explain?: string; cite?: string }
const selKey = (sel: Sel) => `${sel.requestId ?? ''}\n${sel.text}`

/** What tells a selection from another: its row and its words; '' for none. */
export const selectionKey = (sel: Sel | undefined): string => (sel ? selKey(sel) : '')

async function doneNow($: Engine): Promise<Done> {
  return ((await $.state.get(DONE).catch(() => null))?.value ?? {}) as Done
}
async function noteDone($: Engine, k: keyof Done, sel: Sel): Promise<void> {
  await $.state.set(DONE, { ...(await doneNow($)), [k]: selKey(sel) }).catch(() => undefined)
}

/** The marks Claude Code draws before a row (● ⎿ and the like). */
const LEAD = /^[\s●⏺⎿▎│]+/u

/** The words of a text, as compared: its runs of letters and digits, lowercased. */
const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** A selection or a control's words, as compared whole: one space, lowercased, without a row's leading marks. */
const asWhole = (s: string) => s.replace(LEAD, '').replace(/\s+/g, ' ').trim().toLowerCase()

// the words each row of Claude's draws now, and the words of thimble's controls, by where they are drawn
const shown = new Map<string, { raw: string; text: string }>()
const controls = new Map<string, Set<string>>()

/** A row of Claude's that holds the words `raw` draws `text` now (marks/register.ts: the version shown in place of
 *  Claude's, corrected citations among them). */
export function shownWords(row: string, raw: string, text: string): void {
  shown.set(row, { raw, text })
}

/** The words of thimble's own controls drawn now at one place (`at`: the bar, a card's header, the chips, the tray):
 *  each item's words, and its key with them. They replace what that place drew before. */
export function controlWords(at: string, words: string[]): void {
  controls.set(at, new Set(words.map(asWhole).filter(Boolean)))
}

/** The ways a row's words are read, each as its words: as written, with each link's target after its words as Claude
 *  Code draws it, and with each link as its words alone, as a card's link and a link inside a citation draw; and so
 *  the version it draws in their place, when it draws another. */
function readings(row: string, text: string): string[][] {
  const s = shown.get(row)
  const drawn = s && s.raw === text && s.text !== text ? [s.text, withoutLinks(s.text)] : []
  return [...new Set([text, withoutLinks(text), ...drawn])].map(wordsOf)
}

/** A row's words with its citations as their checks left them, as it draws them: a sentence a check rewrote, a
 *  corrected citation's words (message.js), each read as readings reads a row. */
function corrected(text: string, items: MarkItem[]): string[][] {
  if (!items.length) return []
  const asked = withAsked(text, items)
  const shownText = withCorrections(rewritesIn(asked.text, asked.items).text, asked.items)
  return [...new Set([shownText, withoutLinks(shownText)])].map(wordsOf)
}

/** Whether a line's words stand in `all`, in a row: each one whole, but the first may be the end of a word
 *  (`cut.start`: a drag began inside it) and the last the start of one (`cut.end`), and one at least is whole. */
function standsIn(line: string[], all: string[], cut: { start: boolean; end: boolean }): boolean {
  const n = line.length
  if (!n) return false
  next: for (let i = 0; i + n <= all.length; i++) {
    let whole = 0
    for (let k = 0; k < n; k++) {
      const a = all[i + k]!
      const w = line[k]!
      if (a === w) { whole++; continue }
      if (n > 1 && k === 0 && cut.start && a.endsWith(w)) continue
      if (n > 1 && k === n - 1 && cut.end && a.startsWith(w)) continue
      continue next
    }
    if (whole) return true
  }
  return false
}

/** Claude Code's selection; none where it reports none. */
export async function selectionNow($: Engine): Promise<Sel | undefined> {
  try { return await $.ui.selection() } catch { return undefined }
}

export async function answerSelection($: Engine): Promise<Sel | undefined> {
  return answerSelectionOf($, await selectionNow($))
}

/** answerSelection of a selection read before (selectionNow), so a key that read it reads it no more. */
export async function answerSelectionOf($: Engine, sel: Sel | undefined): Promise<Sel | undefined> {
  if (!sel?.text?.trim() || selKey(sel) === (await doneNow($)).dropped) return undefined
  // the words of one of thimble's controls, whole: a double click on it selected them
  const whole = asWhole(sel.text)
  if ([...controls.values()].some(set => set.has(whole))) return undefined
  const lines = sel.text.split('\n')
  const worded = lines.map((line, i) => (wordsOf(line).length ? i : -1)).filter(i => i >= 0)
  const [first, last] = [worded[0], worded[worded.length - 1]]
  // where the drag began and ended a word may be cut: in a row, and across rows; a line alone outside the transcript
  // stands whole
  const ends = !!sel.requestId || worded.length > 1
  const keep = (texts: string[][]) => lines.filter((line, i) => {
    const words = wordsOf(line)
    const cut = { start: ends && i === first, end: ends && i === last }
    return texts.some(t => standsIn(words, t, cut))
  })
  let kept: string[]
  if (sel.requestId) {
    const own = (await messageOf($, sel.requestId))?.text
    // a row of Claude Code's own: a tool call, the turn's time, the person's prompt
    if (own == null) return undefined
    kept = keep(readings(sel.requestId, own))
    // none of Claude's words: its citations' words as the row draws them, corrected (marks/register.ts drawAnswer)
    if (!kept.length) kept = keep(corrected(own, (await rowMarks($, sel.requestId).catch(() => null))?.items ?? []))
  } else {
    const rows = await textRows($).catch(() => [] as string[])
    kept = keep((await Promise.all(rows.map(async row => readings(row, (await messageOf($, row))?.text ?? '')))).flat())
  }
  if (!kept.length) return undefined
  const text = kept.map(line => line.replace(LEAD, '').trim()).join('\n')
  return text === sel.text ? sel : { ...sel, text }
}

export async function dropSelection($: Engine): Promise<void> {
  const sel = await selectionNow($)
  if (sel?.text && !sel.requestId) await noteDone($, 'dropped', sel)
}

export async function selectionUsed($: Engine, by: 'explain' | 'cite', sel: Sel | undefined): Promise<void> {
  if (sel) await noteDone($, by, sel)
}

export async function usedBy($: Engine, by: 'explain' | 'cite', sel: Sel | undefined): Promise<boolean> {
  return !!sel && (await doneNow($))[by] === selKey(sel)
}
