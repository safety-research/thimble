// notices.mjs: what main reads after the check of its citations or a repair of one, and the request a repair's fork
// reads, built from the registry's `notices` text (prompts/notices.md). Pure: the caller reads the text (core/tell.ts
// with promptText) and hands in its parts. The workbench builds its notices with this module too
// (browser/backend/app/notices_of.mjs), from the same text with its own words in the slot.
//
//   partsOf(text)                  the text's parts by name: each `<!-- name -->` line opens one, which runs to the
//                                  next
//   tellText(parts, items)         after a reply's check: each mark it corrected or flagged, as the analyst reads it
//                                  in the reply, and each note, which the analyst does not see; '' when there is none
//   repairTellText(parts, items, auto)   after a repair: how its marks ended, and who started it, the analyst or thimble
//   repairRequest(parts, m, n, auto, also, ran)   what follows the checker's text for a repair: which mark, what the
//                                  first check found (for a stale mark, which files changed after it, each card that
//                                  ran again since, each other stale mark of its sentence that the repair checks with
//                                  it, and that a changed value is corrected in the sentence), and the task
//
// The check's own words (its reason, its note) are quoted, since they may quote the records.
import { fenced } from '../core/text.js'
import { fill } from '../prompts/registry.mjs'
import { staleFiles, staleOf } from '../tray/tray.mjs'
import { plainSentence } from './message.js'

const PART = /^<!--\s*([a-z][a-z -]*?)\s*-->\s*$/m

/** A text's parts, {name: its words}: each `<!-- name -->` line opens a part, which runs to the next such line,
 *  trimmed. */
export function partsOf(text) {
  const bits = String(text || '').split(PART)
  const out = {}
  for (let i = 1; i < bits.length; i += 2) out[bits[i].trim()] = String(bits[i + 1] || '').trim()
  return out
}

/** Words in quotes, unless they open with one. */
const q = w => (/^["“]/.test(String(w)) ? String(w) : `"${w}"`)
/** The check's reason, after a line's words. */
const why = (p, m) => (m.reason ? ` ${fill(p.why, { REASON: q(m.reason) })}` : '')
/** A line of the mark's words in part `part`. */
const wordsLine = (p, part, m) => fill(p[part], { WORDS: q(m.words), WHY: why(p, m) })

/** A correction as main reads it: a narrowing keeps the rest of the words in the reply, uncited; a rewrite puts a new
 *  sentence in place of the one main wrote. */
function fixedLine(p, m) {
  const was = q(m.was || m.words)
  if (m.rewrite) {
    const words = { SENTENCE: q(plainSentence(m.sentence)), REWRITE: q(plainSentence(m.rewrite)), SHOWN: q(m.shown) }
    return fill(p.rewritten, { ...words, WHY: why(p, m) })
  }
  if (m.narrowed) return fill(p.narrowed, { WAS: was, SHOWN: q(m.shown), WHY: why(p, m) })
  return fill(p.corrected, { WAS: was, SHOWN: q(m.shown), WHY: why(p, m) })
}

/** The notes the analyst reads under the blocks of the marks' sentences: one note a sentence (the forks share out
 *  sentences, so two notes on one sentence say the same thing). */
export function notesOf(items) {
  const seen = new Set()
  return items.filter(m => m.note && !seen.has(m.sentence) && seen.add(m.sentence)).map(m => m.note)
}

/** The notes as main reads them: the part that says the analyst does not see them, and a line each. */
const notesPart = (p, notes) => `${p.unseen}\n${fenced(notes.map(n => `- ${q(n)}`).join('\n'))}`

/** After a reply's check: each mark it corrected or flagged (a mark whose check did not run is no finding), and each
 *  note. The person sees every failed mark alike (not confirmed); main hears whether the check found it false or only
 *  could not confirm it. When every mark it tells of is one the analyst asked about, the head says so. */
export function tellText(p, items) {
  const finding = m => m.status === 'corrected' || (m.status === 'failed' && m.failedBy !== 'none')
  const said = items.filter(finding).map(m => {
    if (m.status === 'corrected') return fixedLine(p, m)
    return wordsLine(p, m.failedBy === 'evidence' ? 'not confirmed' : 'wrong', m)
  })
  const notes = notesOf(items)
  if (!said.length && !notes.length) return ''
  const told = items.filter(m => m.status === 'corrected' || m.status === 'failed' || m.note)
  const asked = told.length > 0 && told.every(m => m.asked)
  const parts = [asked ? p['check asked'] : p.check]
  if (said.length) parts.push(`${p.seen}\n${fenced(said.join('\n'))}`)
  if (notes.length) parts.push(notesPart(p, notes))
  parts.push(p['check end'])
  return parts.join('\n')
}

/** After a repair: how its mark ended, as the person reads it, and who started it: the analyst, or thimble (`auto`,
 *  right after the check failed it). */
export function repairTellText(p, items, auto = false) {
  const lines = items.map(m => {
    if (m.status === 'corrected') return fixedLine(p, m)
    if (m.status === 'verified') return wordsLine(p, 'verified', m)
    if (m.status === 'failed' && m.failedBy === 'none') return wordsLine(p, 'not checked', m)
    if (m.status === 'failed') return wordsLine(p, m.failedBy === 'evidence' ? 'still not confirmed' : 'still wrong', m)
    return wordsLine(p, 'not checked again', m)
  })
  if (!lines.length) return ''
  const notes = notesOf(items)
  const parts = [`${auto ? p['repair auto'] : p.repair}\n${fenced(lines.join('\n'))}`]
  if (notes.length) parts.push(notesPart(p, notes))
  parts.push(p['repair end'])
  return parts.join('\n')
}

/** The files a stale mark rests on that changed after its check (tray.mjs staleOf), or, for one whose check since it
 *  went stale did not pass, those it keeps (marks/store.ts MarkItem `fresh`), in a list; '' for any other mark. */
function changedFiles(m) {
  const stale = staleOf(m)
  return stale.length ? staleFiles(stale) : Array.isArray(m?.fresh) && m.fresh.length ? staleFiles(m.fresh.map(file => ({ file }))) : ''
}

/** What follows the checker's text for a repair of mark `m`, numbered `n` in it: who asked, the analyst or thimble
 *  (`auto`, right after the check failed it), what the first check found, and the task. A mark whose first check did
 *  not run is checked as any reply's is; a stale one (tray.mjs staleOf) against the files that changed after its check,
 *  as they are now, and so is one whose check since it went stale did not pass (marks/store.ts MarkItem `fresh`), with
 *  the other such marks of its sentence (`also`, each with its number `n` in the checker's text), which one rewrite of
 *  the sentence corrects together: a value that changed is corrected in the sentence, and what it was goes in the
 *  check's reason. `ran`: the cards that ran again after the change, each as a citation names it (`card:<id>`), whose
 *  cells show the files as they are now (the workbench runs each card the stale marks rest on before their check:
 *  browser/backend/app/marks.py repair). */
export function repairRequest(p, m, n, auto = false, also = [], ran = []) {
  const files = changedFiles(m)
  if (files) {
    const cards = ran.map(card => fill(p['request card ran'], { CARD: card }))
    const more = also.map(x => fill(p['request stale also'], { N: String(x.n), FILES: changedFiles(x) }))
    const stale = [fill(p['request stale'], { N: String(n), FILES: files }), ...cards, p['request where'], ...more, p['request stale value']]
    return [stale.join(' '), p['request task']].join('\n')
  }
  if (m.status === 'unchecked' || m.failedBy === 'none') {
    return `${fill(p['request not run'], { N: String(n) })} ${p['request where']}`
  }
  const found = m.failedBy === 'evidence' ? p['found not confirmed'] : p['found wrong']
  const who = fill(auto ? p['request auto'] : p.request, { N: String(n) })
  return [`${who} ${p['request where']} ${found}${m.reason ? `: ${q(m.reason)}` : '.'}`, p['request task']].join('\n')
}
