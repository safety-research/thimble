// where.ts: w, where words come from, while Citations is manual (settings/features.mjs): Claude cites nothing, and the
// analyst selects words of an answer with the mouse ($.ui.selection, fullscreen layout only) and presses w, or types
// /where and the words. The words become a citation of the answer, as one Claude wrote would be (store.ts MarkItem
// `asked`, drawn as a mark by message.js withAsked), and the tray opens on it, which starts its check (checker.ts
// checkOpened): a second Claude finds where they come from in the files or in what code printed, and the tray shows the
// evidence, verified, corrected or failed, as for any citation.
//
//   WHERE_KEYS, whereKey($, key), whereBar   w at an empty prompt, `w where from` on the bar while words are
//                                            selected, beside `e explain`
//   whereWords($, row, words)                the citation of these words on that answer: an existing one (Claude's, or
//                                            one asked before) when the words stand inside it, else a new one; opened
//   registerWhere                            /where <words>: the same for typed words, in any layout
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failCleared, noticeLine } from '../bar/notice'
import { fullscreenNow } from '../cards/draw'
import { answerRows, messageOf, turnOfRow } from '../core/answers'
import { pickedWords, wordsSelected } from '../explain/seam'
import type { Take } from '../hooks/keys'
import { featureOn } from '../settings/features.mjs'
import { squeezeView } from '../squeeze/seam'
import { openTray } from '../tray/seam'
import { askedWords, codeRanges, marksIn, sentenceOf, withoutMarks } from './message.js'
import { editReply, newReply, replyKeyOf, replyOf, type MarkItem } from './store'

type Engine = EngineInterface

/** The bar's key that finds where the selected words come from. */
export const WHERE_KEYS = ['w']

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
export async function whereWords($: Engine, row: string, words: string): Promise<string | void> {
  const raw = (await messageOf($, row))?.text ?? ''
  const v = await squeezeView($, row, raw).catch(() => null)
  if (typeof v?.text === 'string' && v.text !== raw) return 'w finds the source of Claude\'s own words: press 0 on the answer to see them as written, then select again.'
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

/** w, or a click on `w where from`: the words the analyst last selected with the mouse, on the answer they lie in
 *  (else the newest answer that holds them), found in the files. */
export async function whereSelection($: Engine): Promise<void> {
  const sel = await $.ui.selection().catch(() => undefined)
  const { words } = pickedWords(sel?.text ?? '')
  if (!words) {
    noticeLine($, fullscreenNow() === false
      ? 'Selecting words with the mouse needs Claude Code\'s fullscreen layout. Here, type /where and the words.'
      : 'Select words in an answer with the mouse first, then press w to find where they come from.', 'where')
    return
  }
  await failCleared($, 'where')
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { noticeLine($, 'No answer to find words in yet: ask Claude something first.', 'where'); return }
  const why = await whereWords($, row, words)
  if (why) noticeLine($, why, 'where')
}

/** w at an empty prompt, while Citations is manual and an answer exists: after the word window (a w that starts a
 *  word is typed), the selected words are looked up. */
export async function whereKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (!WHERE_KEYS.includes(key) || !featureOn('where') || !(await answerRows($).catch(() => [])).length) return null
  return { later: () => whereSelection($) }
}

/** `w where from` on the bar, while Citations is manual and an answer exists; a click does what w does. */
export async function whereBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (!on('where')) return []
  if (preview) return [{ id: 'where', key: 'w', words: 'where from' }]
  // while words are selected, as `e explain` (explain/seam.ts watchSelection draws the bar again when that changes)
  if (!(await wordsSelected($))) return []
  if (!(await answerRows($).catch(() => [])).length) return []
  return [{ id: 'where', key: 'w', words: 'where from', press: () => whereSelection($) }]
}

/** /where <words>: where typed words of the newest answer that holds them come from. */
async function whereCommand($: Engine, args: string): Promise<{ text?: string }> {
  const words = pickedWords(args).words
  if (!words) return { text: 'Type the words to find after /where, such as /where 13,339 saves.' }
  if (!featureOn('where')) return { text: 'Set Citations to manual in /thimble-settings to find where words come from.' }
  const row = await rowHolding($, words)
  if (!row) return { text: 'No answer to find words in yet: ask Claude something first.' }
  const why = await whereWords($, row, words)
  return why ? { text: why } : {}
}

export const registerWhere: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'where', description: 'Find where words of an answer come from: /where 13,339 saves', argumentHint: '<words to find>', immediate: true })
    } catch {
      // w still finds them
    }
    return r
  }).catch(($, e, next) => next(e))
  on('command.run', { command: /^(thimble:)?where$/ }, async ($, e) => whereCommand($, String((e as { args?: string }).args ?? '')))
}
