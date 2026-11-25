// ask.mjs: what the explainer on demand reads after the registry's `explain-expand` text, and what its reply gives, as
// both modes write one: the terminal's e (explain/expand.ts) and the workbench's (browser/backend/app/explain.py,
// through explain_of.mjs). Pure: each mode's reader reads the files and hands in what it read.
//
//   evidencePlaces(items)          -> the file places the check's evidence found for an answer's citations
//   citedFiles(places, read)       -> the lines of the files at those places, numbered, as the call reads them
//   askText({term, question, answer, files})   -> what follows the text: the words, the analyst's question, the answer
//                                     the words stand in, and those files' lines
//   explainerOf(text)              -> {body, here} of the reply, cut to their lengths, or null
import { jsonIn } from '../observer/reply.mjs'

export const FILES_BUDGET = 14000 // characters of cited files the call reads
const AROUND = 12 // lines read on each side of a cited span
const QUESTION_MAX = 2000 // characters of the analyst's question
const ANSWER_MAX = 12000 // characters of the answer
const BODY_MAX = 2400 // characters of an explainer's body
const HERE_MAX = 800 // characters of its "where it mattered"

/** The file places the checker's evidence found for an answer's citations (marks/store.ts MarkItem.evidence): each
 *  evidence's file and cited lines, `{path, from, to}`; a value a card shows or code printed names no file. */
export function evidencePlaces(items) {
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    const ev = it?.evidence
    if (!ev || ev.kind === 'computed' || ev.kind === 'card') continue
    for (const pl of [ev, ...(Array.isArray(ev.more) ? ev.more : [])]) {
      if (typeof pl?.file !== 'string') continue
      const m = /^(\d+)(?:\D+(\d+))?/.exec(String(pl.line ?? ''))
      out.push({ path: pl.file, from: m ? Number(m[1]) : null, to: m ? Number(m[2] || m[1]) : null })
    }
  }
  return out
}

/** The lines of the files at `places`, numbered, as the call reads them: AROUND lines on each side of a cited span, a
 *  file's first 60 lines where no line is named; each place once, at most FILES_BUDGET characters in all; '' when
 *  none. `read(path)` gives a file's text, or null where it cannot be read. */
export async function citedFiles(places, read) {
  const out = []
  let used = 0
  const seen = new Set()
  for (const p of places) {
    const key = `${p.path}#${p.from ?? ''}-${p.to ?? ''}`
    if (!p.path || seen.has(key)) continue
    seen.add(key)
    const text = await read(p.path)
    if (text == null) continue
    const all = String(text).split('\n')
    const a = p.from ? Math.max(1, p.from - AROUND) : 1
    const b = p.from ? Math.min(all.length, (p.to ?? p.from) + AROUND) : Math.min(all.length, 60)
    const body = all.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(5)}  ${l.slice(0, 240)}`).join('\n')
    const piece = `--- ${p.path} (lines ${a}–${b} of ${all.length})\n${body}`
    if (used + piece.length > FILES_BUDGET) break
    out.push(piece)
    used += piece.length
  }
  return out.join('\n\n')
}

/** What follows the `explain-expand` text: the words, the analyst's question, the answer as the analyst reads it, and
 *  the lines of the files it cites (citedFiles; none when ''). */
export function askText({ term, question, answer, files }) {
  return [
    `The term: ${term}`,
    '',
    `The analyst's question: ${String(question || '(not known)').slice(0, QUESTION_MAX)}`,
    '',
    'The answer the term stands in:',
    '<answer>', String(answer ?? '').slice(0, ANSWER_MAX), '</answer>',
    ...(files ? ['', 'The files the answer cites, with their line numbers:', files] : []),
  ].join('\n')
}

const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '')

/** The explainer a reply gives, `{body, here}`, each cut to its length; null when it gives no body. */
export function explainerOf(text) {
  const d = jsonIn(text)
  const body = cut(d?.body, BODY_MAX)
  return body ? { body, here: cut(d?.here, HERE_MAX) } : null
}
