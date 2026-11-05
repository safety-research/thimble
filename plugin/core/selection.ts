// selection.ts: the words the analyst selected with the mouse that c (marks/cite.ts), e and h (explain/seam.ts) and a
// (threads/seam.ts) act on: words of Claude's answers only. Claude Code answers the last selection ($.ui.selection,
// fullscreen layout only) until the person selects again, dismisses it, or sends their next prompt, wherever it was
// made; so a selection in thimble's pane (a setting's name) or the prompt is none of theirs, and one the pane held is
// dropped when the pane closes.
//
// A line of the selection is an answer's when its words stand in the words of one of Claude's text rows, compared word
// by word (runs of letters and digits: a table's borders, a list's bullet, a link's brackets and the signs after a
// citation are no words; in a script written without spaces, as Chinese, Japanese and Thai are, each letter is a
// word), and it holds one of them whole (a piece of one word is none):
//   - in a row (Claude Code names the row a selection lies in): one of Claude's text rows, as it draws its words (as
//     Claude wrote them, a link's words and its target, the version shown in their place: a rewrite, corrected
//     citations; shownWords), and the selection's first and last words may be cut where the drag began and ended. A
//     row of Claude Code's own (a tool call, the turn's time, the person's prompt) holds no answer's words
//   - in no row (a drag across rows, or outside the transcript: the bar, a pane, the prompt): any of Claude's text
//     rows. Across rows, the first line may start inside a word and the last end inside one; a line alone, outside the
//     transcript, stands there whole (a piece of the prompt's suggestion or of Claude Code's busy word is none)
// A selection in a row of Claude's whose lines are none of these words (a card's body under the answer, a list Claude
// Code numbers anew, a table's cells wrapped, a sign Claude wrote as an entity) counts whole, as the row's, but for one
// line with no word in it (`●○` of a chip's dots) or one that lay, when first seen, inside the title of a card drawn
// then in that row (titleWords: a press that asks about the card, `Ru` of `Runs by status`; its words the row holds,
// `runs`, are the row's). None counts that lay, when first seen, on one of thimble's own controls drawn then
// (controlWords): one line inside a control's words, as a click that slid a cell leaves (`im` of the bar's `thimble`,
// `it` of `c cite`, `1 ` of a chip's `1 Length`) or a double click selects (a chip's `longer`); a selection is first
// seen anew once another was made.
//
//   answerSelection($)   the selection's words that lie in Claude's answers, a line at a time: a drag that starts on a
//                        row of Claude Code's own (`Ran 3 shell commands`, the answer's ● dot) keeps the answer's lines;
//                        undefined when no line is an answer's (answerSelectionOf: of a selection read before)
//   selectionNow($), selectionKey(sel)   Claude Code's selection as it answers it, and what tells one selection from
//                        another ('' for none)
//   dropSelection($)     the pane closes: a selection outside the transcript (the pane's) is dropped
//   selectionUsed($, by, sel), usedBy($, by, sel)   c, e or a took this selection, so the bar stops naming that
//                        key for it until words are selected anew
//   selectionWaits($, by, raw), waitsNow($, by)   whether words of the answers stand selected that a key has not taken
//                        yet: worked out, and kept for the selection; a key's hook reads what was kept while the
//                        selection is the same
//   pickedWords(text)    the words of a selection a key acts on: one line, at most PICK_MAX characters
//   shownWords(row, raw, text)   the words a row of Claude's draws now in place of the ones it holds (`raw`;
//                        marks/register.ts), kept in memory
//   controlWords(at, words, o) the words of thimble's own controls drawn now `at` the bar, a card's header, the chips
//                        or the tray (none once that place is gone), kept in memory; `o.inRow`: drawn in a row of the
//                        transcript (a card's header, the chips), not above the prompt
//   titleWords(card, row, title)   the title a card draws now in a row of the transcript, a press that asks about the
//                        card (none once the card leaves the screen), kept in memory
//
// state: selectionDone, the selection dropped and the ones c, e and a took, by row and words: kept across the
// plugin's loads, since a change in the settings loads it again while the same selection stands
import type { EngineInterface } from 'claude-code'

import { termOf } from '../explain/place.mjs'
import { rewritesIn, withAsked, withCorrections, withoutLinks } from '../marks/message.js'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageOf, textRows } from './answers'

type Engine = EngineInterface
export type Sel = { text: string; requestId?: string }
/** The keys that act on the selected words: c, e and a. */
export type By = 'cite' | 'explain' | 'ask'

const DONE = { plugin: 'thimble', key: 'selectionDone' } as const
type Done = { dropped?: string } & { [by in By]?: string }
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

/** The scripts written without spaces between words: each of their letters is a word of its own. */
const SOLO = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}'
const WORD = new RegExp(`[${SOLO}]|(?:(?![${SOLO}])[\\p{L}\\p{N}\\p{M}])+`, 'gu')

/** The words of a text, as compared: its runs of letters and digits (each letter of a script in SOLO alone),
 *  lowercased. */
const wordsOf = (s: string): string[] => s.toLowerCase().match(WORD) ?? []

/** A selection or a control's words, as compared whole: one space, lowercased, without a row's leading marks. */
const asWhole = (s: string) => s.replace(LEAD, '').replace(/\s+/g, ' ').trim().toLowerCase()

// the words each row of Claude's draws now, and the words of thimble's controls drawn now, by where they are drawn
const shown = new Map<string, { raw: string; text: string }>()
const controls = new Map<string, { inRow: boolean; words: string[] }>()
// the titles the cards draw now, by card: the words of each, by the row it is drawn in
const titles = new Map<string, Map<string, string>>()
// the selection as first seen (its key), and whether it lay then on one of thimble's controls, or on a card's title
let seen: { key: string; onControl: boolean; onTitle: boolean } | null = null

/** A row of Claude's that holds the words `raw` draws `text` now (marks/register.ts: the version shown in place of
 *  Claude's, corrected citations among them). */
export function shownWords(row: string, raw: string, text: string): void {
  shown.set(row, { raw, text })
}

/** The words of thimble's own controls drawn now at one place (`at`: the bar, a card's header, the chips, the tray):
 *  each item's words, and its key with them; none once the place is gone. They replace what that place drew before.
 *  `o.inRow`: the place is drawn in a row of the transcript, where a selection lies in that row (Claude Code names
 *  none for a selection above the prompt, where the bar and the tray stand). */
export function controlWords(at: string, words: string[], o: { inRow?: boolean } = {}): void {
  controls.set(at, { inRow: !!o.inRow, words: words.map(asWhole).filter(Boolean) })
}

/** The title the card `card` draws now in the row `row` of the transcript, a press that asks about the card ('' where
 *  it draws none); `row` null: it draws none in any row (it left the screen). The row may hold its words too, so they
 *  hold a selection only where none of the row's words do (answerSelectionOf). */
export function titleWords(card: string, row: string | null, title: string): void {
  const rows = titles.get(card) ?? new Map<string, string>()
  const words = asWhole(title)
  if (row === null) rows.clear()
  else if (words) rows.set(row, words)
  else rows.delete(row)
  if (rows.size) titles.set(card, rows)
  else titles.delete(card)
}

/** Where the selection lay when it was first seen, kept until another is made: one line inside the words of a control
 *  drawn then where it lies (in a row, a card's header or the chips; else any), or inside the title of a card drawn
 *  then in its row. */
function firstSeen(sel: Sel): { onControl: boolean; onTitle: boolean } {
  const key = selKey(sel)
  if (seen?.key === key) return seen
  const whole = sel.text.trim().includes('\n') ? '' : asWhole(sel.text)
  const row = sel.requestId
  seen = {
    key,
    onControl: !!whole && [...controls.values()].some(c => (c.inRow || !row) && c.words.some(w => w.includes(whole))),
    onTitle: !!whole && !!row && [...titles.values()].some(t => !!t.get(row)?.includes(whole)),
  }
  return seen
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
  // none selected: the next selection is seen anew
  if (!sel?.text?.trim()) { seen = null; return undefined }
  // on one of thimble's controls: a click on it left it selected
  const at = firstSeen(sel)
  if (at.onControl || selKey(sel) === (await doneNow($)).dropped) return undefined
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
    // none still: words the row draws otherwise (a card's body, a list Claude Code numbers anew, a table's wrapped
    // cells, a sign written as an entity), whole; but not one line with no word in it, nor one on a card's title, as
    // a click that slid a cell leaves (on a chip's dots, on the title that asks about the card)
    if (!kept.length) return sel.text.trim().includes('\n') || (worded.length > 0 && !at.onTitle) ? sel : undefined
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

export async function selectionUsed($: Engine, by: By, sel: Sel | undefined): Promise<void> {
  if (!sel) return
  await noteDone($, by, sel)
  if (waitKept.words === selKey(sel)) waitKept = { ...waitKept, by: { ...waitKept.by, [by]: false } }
}

export async function usedBy($: Engine, by: By, sel: Sel | undefined): Promise<boolean> {
  return !!sel && (await doneNow($))[by] === selKey(sel)
}

/** The most of a selection a key acts on: as long a term as an explainer can stand on (explain/place.mjs anchorTerm). */
const PICK_MAX = 120

/** The words of a selection a key acts on: on one line, without the space and quotes around them, at most PICK_MAX
 *  characters, cut after a whole word (`cut`). */
export function pickedWords(text: string): { words: string; cut: boolean } {
  const quotes = /^[\s"“”'‘’`]+|[\s"“”'‘’`]+$/g
  const all = termOf(String(text ?? '')).replace(/\s+/g, ' ').replace(quotes, '')
  if (all.length <= PICK_MAX) return { words: all, cut: false }
  const head = all.slice(0, PICK_MAX + 1)
  const at = head.lastIndexOf(' ')
  return { words: (at > PICK_MAX / 2 ? head.slice(0, at) : head.slice(0, PICK_MAX)).replace(quotes, '').replace(/[,;:]$/, ''), cut: true }
}

// whether words wait for each key, as last worked out for the selection then (`sel`, its key; `words`, the answers'
// words it holds): the bar works it out as it draws, the selection's watch as one is made (explain/seam.ts), and a
// key's hook, which has a few milliseconds of its own time, reads it while the selection is the same, since working it
// out reads the answers' words (as marks/cite.ts keeps c's)
let waitKept: { sel: string; words: string; by: { [by in By]?: boolean } } = { sel: '', words: '', by: {} }

/** Whether words of Claude's answers stand selected (`raw`, the selection as read: selectionNow) that `by` has not
 *  taken yet (Claude Code answers the last selection until the person selects again or sends their next prompt, so
 *  once a key took it, the bar stops naming that key for it): worked out, and kept for the selection. */
export async function selectionWaits($: Engine, by: By, raw: Sel | undefined): Promise<boolean> {
  const sel = await answerSelectionOf($, raw)
  const waits = !!pickedWords(sel?.text ?? '').words && !(await usedBy($, by, sel))
  const key = selectionKey(raw)
  waitKept = { sel: key, words: sel ? selKey(sel) : '', by: { ...(waitKept.sel === key ? waitKept.by : {}), [by]: waits } }
  return waits
}

/** selectionWaits for a key's hook: one read of the selection, and what was kept for it while it is the same. */
export async function waitsNow($: Engine, by: By): Promise<boolean> {
  const raw = await selectionNow($)
  const kept = waitKept.sel === selectionKey(raw) ? waitKept.by[by] : undefined
  return kept ?? selectionWaits($, by, raw)
}
