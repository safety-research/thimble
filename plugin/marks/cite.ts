// cite.ts: c, a citation of words the analyst selected, in every mode of Citations but off (settings/features.mjs; in
// manual, Claude cites nothing, so c is the only way): the analyst selects words of an answer with the mouse
// ($.ui.selection, fullscreen layout only) and presses c. The words become a citation of the answer, as one Claude wrote
// would be (store.ts MarkItem `asked`, drawn as a mark by message.js withAsked), and the tray opens on it, which starts
// its check (checker.ts checkOpened): a second Claude finds where they come from in the files or in what code printed,
// and the tray shows the evidence, verified, corrected or failed, as for any citation. The words are found in the answer
// as it draws: words inside or across a citation (Claude's, or one asked before) open that one, and so do words of a
// sentence a check rewrote, which is the check's; a link (a file's, a web page's, a card's) reads as its words, and a
// new citation on any of them takes in the whole link, which still draws as its words.
//
// c only cites: it acts while words are selected that it has not cited yet, which the bar shows as `c cite`, in the
// citations' purple, first of the keys that act on them (`c cite · e explain · a ask`; the claims keep
// their item at the right, under their own key, w); with none, c is typed into the prompt.
// Whether words wait reads every answer's words, so it is kept in memory for the selection the bar last drew with, and
// c's key reads the selection alone while that one stands.
//
//   CITE_KEYS                             its letter at an empty prompt, which no card may take (hooks/keys.ts ownKeys)
//   citeKey($, key), citeBar, citeShown   c at an empty prompt while words wait, `c cite` on the bar
//   citeWords($, row, words)              the citation of these words on that answer: an existing one (Claude's, or
//                                         one asked before) when the words stand inside or across it, or in a
//                                         sentence its check rewrote, else a new one; opened
import type { EngineInterface } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { SPIN } from '../bar/busy'
import { howTo, hintUsed } from '../bar/hints'
import { failCleared, hintLine } from '../bar/notice'
import { answerRows, messageOf, turnIds, turnOf, turnOfRow } from '../core/answers'
import { answerSelectionOf, pickedWords, selectionKey, selectionNow, selectionUsed, usedBy, type Sel } from '../core/selection'
import { accent } from '../core/theme'
import type { Take } from '../hooks/keys'
import { claudeCites, featureOn } from '../settings/features.mjs'
import { squeezeView } from '../squeeze/seam'
import { tourCited, tourHoldsCites } from '../tour/tour'
import { openTray, trayFocus } from '../tray/seam'
import { awaitsCheck } from './checker'
import { CITE_WHY, citeAt, placeOf } from './asked.mjs'
import { editReply, newReply, replyKeyOf, replyOf, type MarkItem } from './store'

type Engine = EngineInterface

/** c is thimble's own whether or not Citations is on: no card takes it. */
export const CITE_KEYS = ['c']

/** The newest answer whose words hold these, else the newest answer; null with no answer yet. */
async function rowHolding($: Engine, words: string): Promise<string | null> {
  const rows = (await answerRows($).catch(() => [] as string[])).slice().reverse()
  for (const r of rows) {
    if (placeOf((await messageOf($, r))?.text ?? '', words, `×${SPIN}`)) return r
  }
  return rows[0] ?? null
}

/** The tray on citation `n` of the answer `row`; when it shows that one already, it stays (a press on the citation the
 *  tray shows closes it). */
async function showCitation($: Engine, row: string, n: number): Promise<void> {
  const f = await trayFocus($, row)
  if (f?.kind === 'citation' && f.n === n) return
  await openTray($, { row, kind: 'citation', n })
}

/** The citation of `words` on the answer `row`, opened in the tray: Claude's own or an asked one when the words stand
 *  inside or across it, the one whose check rewrote their sentence when they stand in that sentence, else a new one,
 *  whose check opening it starts (asked.mjs citeAt, which the workbench's c reads too). A sentence says why there is
 *  none. */
export async function citeWords($: Engine, row: string, words: string): Promise<string | void> {
  const raw = (await messageOf($, row))?.text ?? ''
  const v = await squeezeView($, row, raw).catch(() => null)
  if (typeof v?.text === 'string' && v.text !== raw) return 'c cites Claude\'s own words: press 0 to see the answer as written, then select again.'
  const key = (await replyKeyOf($, row)) ?? row
  const reply = await replyOf($, key)
  const items = (reply?.items ?? []).filter(m => m.row === row)
  // the words as the answer draws them (marks/register.ts drawAnswer), with the turning glyph after a citation being
  // checked among the signs a selection may hold
  const got = citeAt(raw, items, words, `×${SPIN}`)
  // a citation with no check stored: one whose check starts at the end of its turn, or, in manual, one Claude wrote
  // anyway, which no check is for
  if (got.why === 'unchecked') return claudeCites() ? 'those words are in a citation still being checked; try again in a moment.' : 'those words are in a citation Claude wrote, which Citations manual does not check; select words outside it.'
  if (got.why) return got.why === 'code' ? CITE_WHY.code : CITE_WHY.missing(words)
  if (got.n != null) { await showCitation($, row, got.n); return }
  // while Claude cites, the end of the answer's turn stores its citations as a new reply, in place of one stored now
  if (!reply && claudeCites() && (await awaitsCheck($, row))) return 'Claude is still answering; select the words again once the answer is done.'
  const next = Math.max(0, ...(reply?.items ?? []).map(m => m.n)) + 1
  const item: MarkItem = { n: next, row, words: got.words, start: got.start, end: got.end, status: 'deferred', shown: got.words, asked: true, sentence: got.sentence }
  if (reply) await editReply($, key, r => ({ ...r, items: [...r.items, item] }))
  else {
    const now = Number(await $.clock.now())
    const turn = await turnOfRow($, row)
    // the words were written by the end of the answer's turn: a label is read as it was then (checker.ts wroteAt)
    await newReply($, { key, turnId: turn?.turnId ?? '', rows: [row], startedAt: now, settledAt: now, items: [item], ...(turn?.endedAt ? { wroteAt: turn.endedAt } : {}) })
  }
  await showCitation($, row, next)
}

// Whether words wait for c (citeShown), as this module last worked it out, for the selection Claude Code answered then:
// at each drawing of the bar (citeBar), as the selection's watch sees a new one (explain/seam.ts watchSelection) and
// as c cites them. Claude Code gives a key's hook a few milliseconds of its own time, and the full check reads the
// state of every answer, so many reads in a long session: c's key reads the selection alone and takes this while the
// selection is the same (citeKey), as the other keys read what their modules keep (squeeze/ui.ts, tray/tray.ts).
let waitKept: { sel: string; shown: boolean } | null = null

/** c, or a click on `c cite`: the words the analyst last selected with the mouse, on the answer they lie in (else
 *  the newest answer that holds them), cited and found in the files. */
export async function citeSelection($: Engine): Promise<void> {
  const raw = await selectionNow($)
  const sel = await answerSelectionOf($, raw)
  await selectionUsed($, 'cite', sel)
  // cited, or none to cite: c no longer cites this selection
  waitKept = { sel: selectionKey(raw), shown: false }
  const { words } = pickedWords(sel?.text ?? '')
  if (!words) { await howTo($, 'cite', 'select a passage in an answer and press c to verify the claim.', 'cite'); return }
  await failCleared($, 'cite')
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { await howTo($, 'cite', 'ask Claude something, then select a passage in its answer and press c to verify the claim.', 'cite'); return }
  const why = await citeWords($, row, words)
  if (why) { hintLine($, why, 'cite'); return }
  await hintUsed($, 'cite')
  // the tour's cite step in manual counts the words cited there (tour/tour.ts tourCited)
  await tourCited($, row).catch(() => undefined)
}

/** Whether c cites now: Citations is on, an answer exists, and words are selected that c has not cited yet (Claude
 *  Code answers the last selection until the person selects again, so once c has cited it, c is typed again). */
export async function citeShown($: Engine): Promise<boolean> {
  if (!featureOn('cite') || (await tourHoldsCites($).catch(() => false))) return false
  return shownFor($, await selectionNow($))
}

/** citeShown of a selection read before, kept for c's key (waitKept). */
async function shownFor($: Engine, raw: Sel | undefined): Promise<boolean> {
  const sel = await answerSelectionOf($, raw)
  const shown = !!pickedWords(sel?.text ?? '').words && !(await usedBy($, 'cite', sel)) && (await answered($))
  waitKept = { sel: selectionKey(raw), shown }
  return shown
}

/** Whether an answer exists: the newest turns first, so it reads one or two of them, never every turn. */
async function answered($: Engine): Promise<boolean> {
  const ids = await turnIds($).catch(() => [] as string[])
  for (let k = ids.length - 1; k >= 0; k--) if ((await turnOf($, ids[k]!).catch(() => null))?.answer) return true
  return false
}

/** c at an empty prompt while words wait to be cited (citeShown): after the word window (a c that starts a word is
 *  typed), the selected words are cited; with none, c is typed. Whether words wait is read in the key's hook, since a
 *  key done once the window closed can no longer be typed, within the few milliseconds Claude Code gives the hook (past
 *  them, Claude Code types the key): one read of the selection, and none of the state while it is the selection the bar
 *  last drew with (waitKept); a selection made since is checked in full. */
export async function citeKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (key !== 'c' || !featureOn('cite') || (await tourHoldsCites($).catch(() => false))) return null
  const raw = await selectionNow($)
  const kept = waitKept
  const shown = kept && kept.sel === selectionKey(raw) ? kept.shown : await shownFor($, raw)
  return shown ? { later: () => citeSelection($) } : null
}

/** `c cite` on the bar, in the citations' purple (thimble's), while c cites (citeShown); a click does what c does. The
 *  settings' preview shows it, as it would show with words selected. */
export async function citeBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (!on('cite')) return []
  const item = { id: 'cite', key: 'c', words: 'cite', color: accent() }
  if (preview) return [item]
  if (!(await citeShown($))) return []
  return [{ ...item, press: () => citeSelection($) }]
}
