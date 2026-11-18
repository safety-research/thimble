// asked.mjs: the words the analyst selects in one of Claude's answers, which three keys act on: c cites them, e explains
// them and a asks about them, in the terminal (marks/cite.ts, explain/seam.ts, threads/seam.ts) and at the selection in
// the browser workbench (browser/frontend/src/chat/picked.tsx). No `$`, no DOM, no Node: the hooks module, the page and
// the tests import it.
//
//   pickedWords(text)               -> the words of a selection a key acts on: one line, at most PICK_MAX characters
//   placeOf(text, words, signs)     -> where words, as the analyst read them, stand in an answer's text
//   citeAt(raw, items, words, signs) -> what c does with them: open the citation that stands on them, make a new one
//                                      (its place, words and sentence), or say why it can do neither
//   CITE_WHY                        -> the words of that why, for each mode's line
//
// `signs`: the characters drawn after a citation, which a selection may hold but the answer's words do not: `×` after a
// failed one in both modes, and the terminal's turning glyph after one being checked (marks/view.ts).
import { termOf } from '../explain/place.mjs'
import { askedWords, carrier, codeRanges, linksIn, marksIn, rewritesIn, sentenceOf, sentenceSpan, withAsked, withCorrections, withoutLinks } from './message.js'

/** The most of a selection a key acts on: as long a term as an explainer can stand on (explain/place.mjs anchorTerm). */
export const PICK_MAX = 120

/** The words of a selection a key acts on: on one line, without the space and quotes around them, at most PICK_MAX
 *  characters, cut after a whole word (`cut`). */
export function pickedWords(text) {
  const quotes = /^[\s"“”'‘’`]+|[\s"“”'‘’`]+$/g
  const all = termOf(String(text ?? '')).replace(/\s+/g, ' ').replace(quotes, '')
  if (all.length <= PICK_MAX) return { words: all, cut: false }
  const head = all.slice(0, PICK_MAX + 1)
  const at = head.lastIndexOf(' ')
  return { words: (at > PICK_MAX / 2 ? head.slice(0, at) : head.slice(0, PICK_MAX)).replace(quotes, '').replace(/[,;:]$/, ''), cut: true }
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where `words`, as the analyst read them, stand in an answer's text, on one line: each citation (`[words](#)`) reads
 *  as its words and each link (a file's, a web page's, a card's) as its words, as they draw, and a place on them takes
 *  in the whole citation or link; the spaces and markdown emphasis between words may differ (`**`, `*`, `` ` ``), and
 *  the place found starts and ends on the words themselves. Words not found as selected are looked for without the
 *  `signs` drawn after citations, then with each link's target after its words, as Claude Code draws a link outside a
 *  citation (`upload.py (client/upload.py#L3)`; a card's never). */
export function placeOf(text, words, signs = '×') {
  const marks = marksIn(text)
  const links = linksIn(text)
  const sign = new RegExp(`(^| )[${escapeRe(signs)}]`, 'g')
  // the text with each citation as its words and each link as its words (`targets`: then its target, as drawn), and
  // where each of its characters stands in `text`
  const brackets = new Set()
  for (const m of marks) {
    brackets.add(m.start)
    for (let k = m.start + 1 + m.words.length; k < m.end; k++) brackets.add(k)
  }
  const reading = targets => {
    let read = ''
    const at = []
    for (let i = 0; i < text.length;) {
      const l = links.find(x => x.start === i)
      if (l) {
        for (let k = 0; k < l.words.length; k++) { read += l.words[k]; at.push(l.start + 1 + k) }
        if (targets && !/^card:/i.test(l.target)) for (const ch of ` (${l.target})`) { read += ch; at.push(l.end - 1) }
        i = l.end
        continue
      }
      if (!brackets.has(i)) { read += text[i]; at.push(i) }
      i++
    }
    return { read, at }
  }
  const find = targets => {
    const r = reading(targets)
    const p = wordsIn(r.read, words) ?? wordsIn(r.read, words.replace(sign, ''))
    return p ? { start: r.at[p.start], end: r.at[p.end - 1] + 1 } : null
  }
  const p = find(false) ?? (links.length ? find(true) : null)
  if (!p) return null
  let { start, end } = p
  for (const m of [...links, ...marks]) if (start < m.end && end > m.start) [start, end] = [Math.min(start, m.start), Math.max(end, m.end)]
  return { start, end }
}

/** Where `words` stand in a text read without its citations' brackets (placeOf). */
function wordsIn(text, words) {
  const tokens = String(words).trim().split(/\s+/).filter(Boolean).map(escapeRe)
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

/** Where a place on an answer as it draws (citeAt) stands in the text Claude wrote: back past what the checks changed
 *  (message.js carrier), then past each citation asked about before it, written `[words](#)` in place of the words as
 *  Claude wrote them (withAsked). Null in words a check wrote. */
function writtenPlace(shown, asked, at) {
  const back = carrier(shown, asked.text)(at.start, at.end)
  if (!back) return null
  const added = marksIn(asked.text).reduce((d, m, k) => {
    const it = asked.items[k]
    return it?.asked && m.end <= back.start ? d + (m.end - m.start) - (it.end - it.start) : d
  }, 0)
  return { start: back.start - added, end: back.end - added }
}

/**
 * What c does with `words`, as the analyst read them in an answer that Claude wrote as `raw`, whose citations are
 * `items` (marks/store.ts MarkItem: Claude's by their order in `raw`, an entry with no check yet left empty, then those
 * the analyst asked about before, `asked`), found in the answer as it draws: with those asked about before written in
 * (message.js withAsked), and each sentence a check rewrote and each corrected citation's words in place of Claude's.
 *   {n}       a citation stands on them, which c opens: Claude's or one asked before when they stand inside or across
 *             it, or the one whose check rewrote their sentence, which is the check's and holds no citation asked about
 *   {why}     c can neither open one nor make one: 'missing' (they are not in the answer), 'unchecked' (they stand in a
 *             citation of Claude's that no check holds), 'code' (they are code, which has no source)
 *   {start, end, words, sentence}   a new citation: where its words stand in `raw`, its words as they draw (each link as
 *             its words), and the sentence that holds it as the checker reads it
 */
export function citeAt(raw, items, words, signs = '×') {
  const asked = withAsked(raw, items)
  const rewrote = rewritesIn(asked.text, asked.items)
  const shown = withCorrections(rewrote.text, asked.items)
  const at = placeOf(shown, words, signs)
  if (!at) return { why: 'missing' }
  // words inside or across a citation the answer draws (Claude's, or asked before) open it
  const marks = marksIn(shown)
  const hit = marks.findIndex(m => at.start < m.end && at.end > m.start)
  if (hit >= 0 && !asked.items[hit]) return { why: 'unchecked' }
  // so do words asked about before that it does not draw; and words of a sentence a check rewrote open the citation it
  // was rewritten for
  const place = writtenPlace(shown, asked, at)
  const before = place && items.find(m => m?.asked && place.start < m.end && place.end > m.start)
  const fixed = marks.findIndex((m, k) => {
    const [a, b] = sentenceSpan(shown, m)
    return rewrote.placed.has(k) && at.start < b && at.end > a
  })
  const n = hit >= 0 ? asked.items[hit].n : before ? before.n : fixed >= 0 ? asked.items[fixed].n : null
  if (n != null) return { n }
  if (!place) return { why: 'missing' }
  if (codeRanges(raw).some(([a, b]) => place.start < b && place.end > a)) return { why: 'code' }
  // the citation is written on the words with their links kept (withAsked); its words are as they draw
  const written = askedWords(raw.slice(place.start, place.end))
  const marked = raw.slice(0, place.start) + `[${written}](#)` + raw.slice(place.end)
  return { start: place.start, end: place.end, words: withoutLinks(written), sentence: sentenceOf(marked, { start: place.start, end: place.start + written.length + 5 }) }
}

/** Why c made no citation, in the words each mode's line says: `missing` names the words, cut to 50 characters. The
 *  words for `unchecked` are each mode's, since what holds a citation's check differs. */
export const CITE_WHY = {
  missing: words => `“${words.length > 50 ? `${words.slice(0, 49)}…` : words}” isn't in the answer; select words of its text.`,
  code: "those words are code, which has no source; select words of the answer's text.",
}
