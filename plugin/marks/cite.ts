// cite.ts: c, a citation of words the analyst selected, in every mode of Citations but off (settings/features.mjs; in
// manual, Claude cites nothing, so c is the only way): the analyst selects words of an answer with the mouse
// ($.ui.selection, fullscreen layout only) and presses c. The words become a citation of the answer, as one Claude wrote
// would be (store.ts MarkItem `asked`, drawn as a mark by message.js withAsked), and the tray opens on it, which starts
// its check (checker.ts checkOpened): a second Claude finds where they come from in the files or in what code printed,
// and the tray shows the evidence, verified, corrected or failed, as for any citation. The words are found in the answer
// as it draws: words inside or across a citation (Claude's, or one asked before) open that one.
//
// c is also the Claims pane's key: c cites only while words are selected that it has not cited yet, which the bar shows
// as `c cite` (beside `e explain`, the claims' item set aside meanwhile); else c opens the claims (core/answerview.ts
// asks which once the word window closed).
//
//   citeKey($, key), citeBar, citeShown   c at an empty prompt while words wait, `c cite` on the bar
//   citeWords($, row, words)              the citation of these words on that answer: an existing one (Claude's, or
//                                         one asked before) when the words stand inside or across it, else a new
//                                         one; opened
import type { EngineInterface } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { SPIN } from '../bar/busy'
import { howTo, hintUsed } from '../bar/hints'
import { failCleared, hintLine } from '../bar/notice'
import { answerRows, messageOf, turnOfRow } from '../core/answers'
import { answerSelection, selectionUsed, usedBy } from '../core/selection'
import { pickedWords } from '../explain/seam'
import type { Take } from '../hooks/keys'
import { claudeCites, featureOn } from '../settings/features.mjs'
import { squeezeView } from '../squeeze/seam'
import { openTray, trayFocus } from '../tray/seam'
import { awaitsCheck } from './checker'
import { askedWords, carrier, codeRanges, marksIn, rewritesIn, sentenceOf, withAsked, withCorrections } from './message.js'
import { editReply, newReply, replyKeyOf, replyOf, type MarkItem } from './store'

type Engine = EngineInterface

/** The sign drawn after a citation, with the space before it (× after a failed one, the turning glyph after one being
 *  checked: marks/view.ts): no word of the answer. */
const SIGN = new RegExp(`(^| )[×${SPIN}]`, 'g')

/** Where `words`, as the analyst read them, stand in an answer's text, on one line: each citation (`[words](#)`) reads
 *  as its words, and a place on them takes in the whole citation; the spaces and markdown emphasis between words may
 *  differ (`**`, `*`, `` ` ``), and the place found starts and ends on the words themselves. Words not found as
 *  selected are looked for without the signs drawn after citations. */
export function placeOf(text: string, words: string): { start: number; end: number } | null {
  const marks = marksIn(text)
  // the text with each citation as its words, and where each of its characters stands in `text`
  let read = ''
  const at: number[] = []
  let i = 0
  for (const m of [...marks, { start: text.length, end: text.length, words: '' }]) {
    for (; i < m.start; i++) { read += text[i]; at.push(i) }
    for (let k = 0; k < m.words.length; k++) { read += m.words[k]; at.push(m.start + 1 + k) }
    i = m.end
  }
  const p = wordsIn(read, words) ?? wordsIn(read, words.replace(SIGN, ''))
  if (!p) return null
  let [start, end] = [at[p.start]!, at[p.end - 1]! + 1]
  for (const m of marks) if (start < m.end && end > m.start) [start, end] = [Math.min(start, m.start), Math.max(end, m.end)]
  return { start, end }
}

/** Where `words` stand in a text read without its citations' brackets (placeOf). */
function wordsIn(text: string, words: string): { start: number; end: number } | null {
  const tokens = String(words).trim().split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!tokens.length) return null
  const m = new RegExp(tokens.join('(?:[^\\S\\n]|\\*|`)+')).exec(text)
  if (!m) return null
  // emphasis opened or closed inside the words takes its other half from just outside them, so the text stays balanced
  let [start, end] = [m.index, m.index + m[0].length]
  for (const mark of ['**', '`', '*']) {
    const inside = text.slice(start, end).split(mark === '*' ? /(?<!\*)\*(?!\*)/ : mark).length - 1
    if (inside % 2 === 0) continue
    if (text.slice(start - mark.length, start) === mark) start -= mark.length
    else if (text.slice(end, end + mark.length) === mark) end += mark.length
  }
  return { start, end }
}

/** The newest answer whose words hold these, else the newest answer; null with no answer yet. */
async function rowHolding($: Engine, words: string): Promise<string | null> {
  const rows = (await answerRows($).catch(() => [] as string[])).slice().reverse()
  for (const r of rows) {
    if (placeOf((await messageOf($, r))?.text ?? '', words)) return r
  }
  return rows[0] ?? null
}

/** Where a place on an answer as it draws (citeWords) stands in the text Claude wrote: back past what the checks changed
 *  (message.js carrier), then past each citation asked about before it, written `[words](#)` in place of the words as
 *  Claude wrote them (withAsked). Null in words a check wrote. */
function writtenPlace(shown: string, asked: { text: string; items: MarkItem[] }, at: { start: number; end: number }): { start: number; end: number } | null {
  const back = carrier(shown, asked.text)(at.start, at.end)
  if (!back) return null
  const added = marksIn(asked.text).reduce((d, m, k) => {
    const it = asked.items[k]
    return it?.asked && m.end <= back.start ? d + (m.end - m.start) - (it.end - it.start) : d
  }, 0)
  return { start: back.start - added, end: back.end - added }
}

/** The tray on citation `n` of the answer `row`; when it shows that one already, it stays (a press on the citation the
 *  tray shows closes it). */
async function showCitation($: Engine, row: string, n: number): Promise<void> {
  const f = await trayFocus($, row)
  if (f?.kind === 'citation' && f.n === n) return
  await openTray($, { row, kind: 'citation', n })
}

/** The citation of `words` on the answer `row`, opened in the tray: Claude's own or an asked one when the words stand
 *  inside or across it, else a new one, whose check opening it starts. A sentence says why there is none. */
export async function citeWords($: Engine, row: string, words: string): Promise<string | void> {
  const raw = (await messageOf($, row))?.text ?? ''
  const v = await squeezeView($, row, raw).catch(() => null)
  if (typeof v?.text === 'string' && v.text !== raw) return 'c cites Claude\'s own words: press 0 to see the answer as written, then select again.'
  const key = (await replyKeyOf($, row)) ?? row
  const reply = await replyOf($, key)
  const items = (reply?.items ?? []).filter(m => m.row === row)
  // the words as the answer draws them (marks/register.ts drawAnswer): with the citations asked about before, and each
  // sentence a check rewrote and each corrected citation's words in place of Claude's
  const asked = withAsked(raw, items)
  const rewrote = rewritesIn(asked.text, asked.items)
  const shown = withCorrections(rewrote.text, asked.items)
  const missing = `“${words.length > 50 ? `${words.slice(0, 49)}…` : words}” isn't in the answer; select words of its text.`
  const at = placeOf(shown, words)
  if (!at) return missing
  // words inside or across a citation the answer draws (Claude's, or asked before) open it
  const marks = marksIn(shown)
  const hit = marks.findIndex(m => at.start < m.end && at.end > m.start)
  if (hit >= 0 && !asked.items[hit]) return 'those words are in a citation still being checked; try again in a moment.'
  // so do words asked about before that it does not draw
  const place = writtenPlace(shown, asked, at)
  const before = place && items.find(m => m.asked && place.start < m.end && place.end > m.start)
  const n = hit >= 0 ? asked.items[hit].n : before ? before.n : null
  if (n != null) { await showCitation($, row, n); return }
  if (!place) return missing
  if (codeRanges(raw).some(([a, b]) => place.start < b && place.end > a)) return 'those words are code, which has no source; select words of the answer\'s text.'
  // while Claude cites, the end of the answer's turn stores its citations as a new reply, in place of one stored now
  if (!reply && claudeCites() && (await awaitsCheck($, row))) return 'Claude is still answering; select the words again once the answer is done.'
  const text = askedWords(raw.slice(place.start, place.end))
  const next = Math.max(0, ...(reply?.items ?? []).map(m => m.n)) + 1
  const marked = raw.slice(0, place.start) + `[${text}](#)` + raw.slice(place.end)
  const item: MarkItem = {
    n: next, row, words: text, start: place.start, end: place.end, status: 'deferred', shown: text, asked: true,
    sentence: sentenceOf(marked, { start: place.start, end: place.start + text.length + 5 }),
  }
  if (reply) await editReply($, key, r => ({ ...r, items: [...r.items, item] }))
  else {
    const now = Number(await $.clock.now())
    await newReply($, { key, turnId: (await turnOfRow($, row))?.turnId ?? '', rows: [row], startedAt: now, settledAt: now, items: [item] })
  }
  await showCitation($, row, next)
}

/** c, or a click on `c cite`: the words the analyst last selected with the mouse, on the answer they lie in (else
 *  the newest answer that holds them), cited and found in the files. */
export async function citeSelection($: Engine): Promise<void> {
  const sel = await answerSelection($)
  await selectionUsed($, 'cite', sel)
  const { words } = pickedWords(sel?.text ?? '')
  if (!words) { await howTo($, 'cite', 'select a passage in an answer and press c to verify the claim.', 'cite'); return }
  await failCleared($, 'cite')
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { await howTo($, 'cite', 'ask Claude something, then select a passage in its answer and press c to verify the claim.', 'cite'); return }
  const why = await citeWords($, row, words)
  if (why) hintLine($, why, 'cite')
  else await hintUsed($, 'cite')
}

/** Whether c cites now: Citations is on, an answer exists, and words are selected that c has not cited yet (Claude
 *  Code answers the last selection until the person selects again, so once c has cited it, c opens the claims again). */
export async function citeShown($: Engine): Promise<boolean> {
  if (!featureOn('cite')) return false
  const sel = await answerSelection($)
  if (!pickedWords(sel?.text ?? '').words || (await usedBy($, 'cite', sel))) return false
  return (await answerRows($).catch(() => [])).length > 0
}

/** c at an empty prompt while words wait to be cited (citeShown): after the word window (a c that starts a word is
 *  typed), the selected words are cited. Else c is the claims' (claims/seam.ts claimsKey). It reads the selection, so
 *  core/answerview.ts asks it at the key only while the claims do not take c. */
export async function citeKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (key !== 'c' || !(await citeShown($))) return null
  return { later: () => citeSelection($) }
}

/** `c cite` on the bar while c cites (citeShown); a click does what c does. The settings' preview shows it, as it would
 *  show with words selected. */
export async function citeBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (!on('cite')) return []
  if (preview) return [{ id: 'cite', key: 'c', words: 'cite' }]
  if (!(await citeShown($))) return []
  return [{ id: 'cite', key: 'c', words: 'cite', press: () => citeSelection($) }]
}
