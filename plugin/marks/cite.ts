// cite.ts: c, a citation of words the analyst selected, while Citations is manual (settings/features.mjs): Claude
// cites nothing, and the analyst selects words of an answer with the mouse ($.ui.selection, fullscreen layout only) and
// presses c. The words become a citation of the answer, as one Claude wrote would be (store.ts MarkItem `asked`, drawn
// as a mark by message.js withAsked), and the tray opens on it, which starts its check (checker.ts checkOpened): a
// second Claude finds where they come from in the files or in what code printed, and the tray shows the evidence,
// verified, corrected or failed, as for any citation.
//
// c is also the Claims pane's key: c cites only while words are selected that it has not cited yet, which the bar shows
// as `c cite` (beside `e explain`, and the claims' item without its key); else c opens the claims.
//
//   citeKey($, key), citeBar, citeShown   c at an empty prompt while words wait, `c cite` on the bar
//   citeWords($, row, words)              the citation of these words on that answer: an existing one (Claude's, or
//                                         one asked before) when the words stand inside it, else a new one; opened
import type { EngineInterface } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failCleared, noticeLine } from '../bar/notice'
import { answerRows, messageOf, turnOfRow } from '../core/answers'
import { pickedWords } from '../explain/seam'
import type { Take } from '../hooks/keys'
import { featureOn } from '../settings/features.mjs'
import { squeezeView } from '../squeeze/seam'
import { openTray } from '../tray/seam'
import { askedWords, codeRanges, marksIn, sentenceOf, withoutMarks } from './message.js'
import { editReply, newReply, replyKeyOf, replyOf, type MarkItem } from './store'

type Engine = EngineInterface

/** The selection c last cited, by its row and words: Claude Code answers the last selection until the person selects
 *  again or sends their next prompt, so once c has cited it, c opens the claims again. */
let cited: string | null = null
const selKey = (sel: { text?: string; requestId?: string } | undefined) => `${sel?.requestId ?? ''}\n${sel?.text ?? ''}`

/** Where `words`, as the analyst read them, stand in the text Claude wrote, on one line: the spaces and markdown
 *  emphasis between them may differ (`**`, `*`, `` ` ``), and the place found starts and ends on the words themselves. */
export function placeOf(text: string, words: string): { start: number; end: number } | null {
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
    if (placeOf(withoutMarks((await messageOf($, r))?.text ?? ''), words)) return r
  }
  return rows[0] ?? null
}

/** The citation of `words` on the answer `row`, opened in the tray: Claude's own or an asked one when the words stand
 *  inside or across it, else a new one, whose check opening it starts. A sentence says why there is none. */
export async function citeWords($: Engine, row: string, words: string): Promise<string | void> {
  const raw = (await messageOf($, row))?.text ?? ''
  const v = await squeezeView($, row, raw).catch(() => null)
  if (typeof v?.text === 'string' && v.text !== raw) return 'c cites Claude\'s own words: press 0 on the answer to see them as written, then select again.'
  const at = placeOf(raw, words)
  if (!at) return `“${words.length > 50 ? `${words.slice(0, 49)}…` : words}” is not in the answer as Claude wrote it. Select words of the answer's text.`
  const key = (await replyKeyOf($, row)) ?? row
  const reply = await replyOf($, key)
  const items = (reply?.items ?? []).filter(m => m.row === row)
  // words inside or across a citation the answer has (Claude's, or asked before) open it
  const own = marksIn(raw)
  const hit = own.findIndex(m => at.start < m.end && at.end > m.start)
  const n = hit >= 0
    ? (items.filter(m => !m.asked)[hit]?.n ?? null)
    : (items.find(m => m.asked && at.start < m.end && at.end > m.start)?.n ?? null)
  if (n != null) { await openTray($, { row, kind: 'citation', n }); return }
  if (hit >= 0) return 'Those words are part of a citation whose check is not ready yet. Try again in a moment.'
  if (codeRanges(raw).some(([a, b]) => at.start < b && at.end > a)) return 'Those words are code, which has no source to find. Select words of the answer\'s text.'
  const text = askedWords(raw.slice(at.start, at.end))
  const next = Math.max(0, ...(reply?.items ?? []).map(m => m.n)) + 1
  const marked = raw.slice(0, at.start) + `[${text}](#)` + raw.slice(at.end)
  const item: MarkItem = {
    n: next, row, words: text, start: at.start, end: at.end, status: 'deferred', shown: text, asked: true,
    sentence: sentenceOf(marked, { start: at.start, end: at.start + text.length + 5 }),
  }
  if (reply) await editReply($, key, r => ({ ...r, items: [...r.items, item] }))
  else {
    const now = Number(await $.clock.now())
    await newReply($, { key, turnId: (await turnOfRow($, row))?.turnId ?? '', rows: [row], startedAt: now, settledAt: now, items: [item] })
  }
  await openTray($, { row, kind: 'citation', n: next })
}

/** c, or a click on `c cite`: the words the analyst last selected with the mouse, on the answer they lie in (else
 *  the newest answer that holds them), cited and found in the files. */
export async function citeSelection($: Engine): Promise<void> {
  const sel = await $.ui.selection().catch(() => undefined)
  cited = selKey(sel)
  const { words } = pickedWords(sel?.text ?? '')
  if (!words) { noticeLine($, 'Select words in an answer with the mouse first, then press c to cite them.', 'cite'); return }
  await failCleared($, 'cite')
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { noticeLine($, 'No answer to cite words in yet: ask Claude something first.', 'cite'); return }
  const why = await citeWords($, row, words)
  if (why) noticeLine($, why, 'cite')
}

/** Whether c cites now: Citations is manual, an answer exists, and words are selected that c has not cited yet. */
export async function citeShown($: Engine): Promise<boolean> {
  if (!featureOn('cite')) return false
  const sel = await $.ui.selection().catch(() => undefined)
  if (!pickedWords(sel?.text ?? '').words || selKey(sel) === cited) return false
  return (await answerRows($).catch(() => [])).length > 0
}

/** c at an empty prompt while words wait to be cited (citeShown): after the word window (a c that starts a word is
 *  typed), the selected words are cited. Else c is the claims' (claims/seam.ts claimsKey). */
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
