// message.js: one of Claude's replies as the marks see it: its marks, its blocks and how they wrap. No `$`, no DOM, no
// Node: the hooks module, the browser page and the tests all import it.
//
// A mark is a markdown link to `#` on the words of a claim: `[352](#) of the [410](#) refund requests`. Its words may
// hold formatting (`**`, a code span) and brackets of their own (`[the [x] flag](#)`). A link to anything else is no
// mark, and a link inside code is no link.
//
//   marksIn(text)              -> each mark of a text: {start, end, words} (start..end the whole link, words as written)
//   sentenceOf(text, mark)     -> the sentence that holds a mark, on one line, each mark as `[words]`
//   sentenceSpan(text, mark)   -> where that sentence stands in the text, [start, end)
//   withRewrites(text, items)  -> the text with the sentences its marks' checks rewrote in place of its own
//   rewritesIn(text, items)    -> that text, and the marks whose rewrite stands in it
//   withCorrections(text, items) -> the text with each corrected mark's words in place of its own
//   carrier(was, now)          -> where a place on a text stands in the version of it the checks made (null: nowhere)
//   plainSentence(sentence)    -> that sentence as a person reads it: no markdown, a table row's cells joined by ` · `
//   withoutMarks(text)         -> the text with each mark as its words alone (marks switched off)
//   blocks(text)               -> the markdown's blocks with their offsets
//   cardRef(line)              -> the card a line of its own places there (`[title](card:<id>)`), or null
//   inline(text, from, to, marks) -> one block's content as runs: words with their style, and each mark as one run
//   wrapRuns(runs, width)      -> the runs cut into lines at spaces, a mark's words as plain words are
//   tableOf(text, block, marks) -> a table block's cells as runs
//   runsText(runs)             -> the plain words of runs
//
// A text's width in cells is core/text.js's, as everywhere in thimble.

import { textWidth } from '../core/text.js'

/** Where code stands in markdown: fenced blocks and inline code spans, as [start, end) ranges. */
export function codeRanges(text) {
  const s = String(text || '')
  const out = []
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[`~]*[ \t]*(?=\n|$)|(?![\s\S]))/gm
  for (const m of s.matchAll(fence)) out.push([m.index, m.index + m[0].length])
  // inline spans are read on a copy with each fence blanked (same length), so a fence's backticks never pair with a
  // span's after it
  let open = ''
  let at = 0
  for (const [a, b] of out) { open += s.slice(at, a) + ' '.repeat(b - a); at = b }
  open += s.slice(at)
  const span = /(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g
  for (const m of open.matchAll(span)) out.push([m.index, m.index + m[0].length])
  return out.sort((a, b) => a[0] - b[0])
}

const inCode = (ranges, i) => ranges.find(([x, y]) => i >= x && i < y)

/**
 * Each mark of a text, in order: {start, end, words}. A `[` outside code opens the words; its `]` is the one that
 * balances it, read past the code spans inside the words; `(#)` must follow at once. The words are on one line.
 */
export function marksIn(text) {
  const s = String(text || '')
  const code = codeRanges(s)
  const out = []
  let i = 0
  while ((i = s.indexOf('[', i)) >= 0) {
    const c0 = inCode(code, i)
    if (c0) { i = c0[1]; continue }
    let depth = 0
    let close = -1
    for (let j = i; j < s.length && s[j] !== '\n'; j++) {
      const c = inCode(code, j)
      if (c) { j = c[1] - 1; continue }
      if (s[j] === '\\') { j++; continue }
      if (s[j] === '[') depth++
      else if (s[j] === ']' && --depth === 0) { close = j; break }
    }
    if (close > i + 1 && s.startsWith('(#)', close + 1)) {
      out.push({ start: i, end: close + 4, words: s.slice(i + 1, close) })
      i = close + 4
    } else i++
  }
  return out
}

/** The text with each mark as its words alone. */
export function withoutMarks(text) {
  const s = String(text ?? '')
  let out = ''
  let at = 0
  for (const m of marksIn(s)) { out += s.slice(at, m.start) + m.words; at = m.end }
  return out + s.slice(at)
}

/**
 * The sentence that holds a mark, as the checker reads it and its evidence shows it: from the end of the sentence
 * before the mark to the end of the one it is in (a `.`, `!` or `?`, after any closing quote, bracket or emphasis,
 * then a space, outside any mark's words), never across a line break; on one line, with no bold, each mark in it written `[words]`.
 */
export function sentenceOf(text, mark) {
  const s = String(text || '')
  const [a, b] = sentenceSpan(s, mark)
  const part = s.slice(a, b)
  let out = ''
  let at = 0
  for (const m of marksIn(part)) { out += part.slice(at, m.start) + `[${m.words}]`; at = m.end }
  // bold as `**` or `__`; a `__` between two letters or digits is part of a name (`chess-nano__goal`)
  return (out + part.slice(at)).replace(/\*\*|(?<![\p{L}\p{N}])__|__(?![\p{L}\p{N}])/gu, '').replace(/\s+/g, ' ').trim()
}

/** Where the sentence that holds a mark stands in the text, as [start, end): sentenceOf's words as written. */
export function sentenceSpan(text, mark) {
  const s = String(text || '')
  let a = s.lastIndexOf('\n', mark.start - 1) + 1
  let b = s.indexOf('\n', mark.end)
  if (b < 0) b = s.length
  const end = /[.!?]["'\u201d\u2019)*_]*\s/g
  end.lastIndex = a
  // a mark's words are one claim: a `.` inside them (a quote of two sentences) ends no sentence
  const marks = marksIn(s)
  for (let e; (e = end.exec(s)) && e.index < b;) {
    if (marks.some(m => e.index > m.start && e.index < m.end)) continue
    const after = e.index + e[0].length
    if (after <= mark.start) a = after
    else if (e.index >= mark.end - 1) { b = after; break }
  }
  return [a, b]
}

/**
 * The text with the sentences its checks rewrote: `items` are the text's marks' checks by their place (marks/store.ts
 * MarkItem), and a corrected one's `rewrite` is the sentence that stands in place of its own, written as sentenceOf
 * writes one (each citation `[words]`, engine/kernel/evidence.py sentence_rewrite). The white space around the sentence
 * stays; a second rewrite of one sentence is left out. Each rewrite stands or not on its own: one that would not hold
 * the marks of the sentence it replaces leaves that sentence as it was. `placed`: the marks whose rewrite stands.
 */
export function rewritesIn(text, items) {
  const s = String(text || '')
  const spans = marksIn(s).flatMap((m, k) => (items[k]?.status === 'corrected' && String(items[k]?.rewrite || '').trim() ? [{ k, span: sentenceSpan(s, m), sentence: String(items[k].rewrite) }] : []))
    .sort((x, y) => y.span[0] - x.span[0])
  let out = s
  let floor = Infinity
  const placed = new Set()
  for (const { k, span: [a, b], sentence } of spans) {
    if (b > floor) continue
    const raw = s.slice(a, b)
    const lead = raw.match(/^\s*/)[0]
    const trail = raw.slice(lead.length).match(/\s*$/)[0]
    const body = asMarks(sentence, raw)
    if (body == null) continue
    out = out.slice(0, a) + lead + body + trail + out.slice(b)
    floor = a
    placed.add(k)
  }
  return { text: out, placed }
}

/** The text with the sentences its checks rewrote (rewritesIn). */
export function withRewrites(text, items) {
  return rewritesIn(text, items).text
}

/** Each `[` and the `]` that balances it, as engine/kernel/evidence.py citations_of reads a sentence: brackets inside
 *  the words stay the words', a `\` escapes the character after it, and code is read as words are. [start, end). */
function bracketGroups(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    if (s[i] !== '[') { i += s[i] === '\\' ? 2 : 1; continue }
    let depth = 0
    let j = i
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue }
      if (s[j] === '[') depth++
      else if (s[j] === ']' && --depth === 0) break
    }
    if (j >= s.length) break
    out.push([i, j + 1])
    i = j + 1
  }
  return out
}

/**
 * A rewrite, written as sentenceOf writes one, as the sentence `raw` it replaces is written: the bracket groups of
 * both stand in the same order (the validator keeps every other citation of the sentence), and each group takes the
 * role its place had in `raw`: a mark's group becomes a mark again (`[words](#)`), a link's keeps its target
 * (`[the log](a.log)`, its target put back when the rewrite wrote the words alone), and brackets that were neither
 * (`[x]` in code, or as written) stay as written. Null when it cannot hold the marks of `raw`: another number of
 * groups, or marks lost.
 */
function asMarks(sentence, raw) {
  const was = bracketGroups(raw).map(([a, b]) => {
    if (raw.startsWith('(#)', b)) return { kind: 'mark' }
    const link = /^\(([^)\n]*)\)/.exec(raw.slice(b))
    return link ? { kind: 'link', target: link[1] } : { kind: 'words' }
  })
  const groups = bracketGroups(sentence)
  if (groups.length !== was.length) return null
  let out = ''
  let at = 0
  groups.forEach(([a, b], i) => {
    out += sentence.slice(at, b)
    const role = was[i]
    if (role.kind === 'mark' && !sentence.startsWith('(#)', b)) out += '(#)'
    if (role.kind === 'link' && sentence[b] !== '(') out += `(${role.target})`
    at = b
  })
  out += sentence.slice(at)
  return marksIn(out).length === marksIn(raw).length ? out : null
}

/**
 * The text with each correction's words in place of its mark's words (`[shown](#)` for `[words](#)`), so what the
 * person reads is the text the features place their words on (an explainer's, a heads-up's). A mark's correction
 * stands when its check corrected it with other words and neither narrowed it (its words stay, only a part is cited)
 * nor rewrote its sentence (rewritesIn), and when the words hold as a mark's (the text keeps its marks).
 */
export function withCorrections(text, items) {
  const s = String(text || '')
  const ms = marksIn(s)
  let out = s
  for (let k = ms.length - 1; k >= 0; k--) {
    const it = items[k]
    const m = ms[k]
    const shown = String(it?.shown ?? '')
    if (it?.status !== 'corrected' || it.narrowed || it.rewrite || !shown.trim() || shown === m.words) continue
    const next = out.slice(0, m.start + 1) + shown + out.slice(m.start + 1 + m.words.length)
    const now = marksIn(next)
    if (now.length !== ms.length || now[k].words !== shown) continue
    out = next
  }
  return out
}

/**
 * Where a place on a text stands in the version of it the checks made (withCorrections, withRewrites): `carrier(was,
 * now)` is a function (start, end) -> {start, end} or null. Both texts hold the same marks; each is cut at its marks'
 * words, and in each piece the words both versions share at its start and at its end keep their place. An end in the
 * words a correction changed goes to that mark's corrected words, so a place on a mark's words stays on them whatever
 * the check made of them. One in words a rewrite changed outside the marks has no place, nor has any when the marks
 * differ.
 */
export function carrier(was, now) {
  const a = String(was || '')
  const b = String(now || '')
  const ma = marksIn(a)
  const mb = marksIn(b)
  if (ma.length !== mb.length) return () => null
  const cuts = (s, ms) => [0, ...ms.flatMap(m => [m.start + 1, m.start + 1 + m.words.length]), s.length]
  const ca = cuts(a, ma)
  const cb = cuts(b, mb)
  const pieces = ca.slice(1).map((ob, i) => {
    const oa = ca[i], na = cb[i], nb = cb[i + 1]
    const most = Math.min(ob - oa, nb - na)
    let p = 0
    while (p < most && a[oa + p] === b[na + p]) p++
    let q = 0
    while (q < most - p && a[ob - 1 - q] === b[nb - 1 - q]) q++
    return { oa, ob, na, nb, p, q, mark: i % 2 === 1 }
  })
  // a start stands in the piece it opens, an end in the piece it closes. Outside a mark, its first or last character
  // must be one both versions share; on a mark's words, one next to the changed words is enough
  const to = (x, end) => {
    const c = pieces.find(k => (end ? x > k.oa && x <= k.ob : x >= k.oa && x < k.ob))
    if (!c) return null
    const k = x - c.oa
    const r = c.ob - x
    if (end ? k <= c.p : k < c.p || (c.mark && k === c.p)) return c.na + k
    if (end ? r < c.q || (c.mark && r === c.q) : r <= c.q) return c.nb - r
    return c.mark ? (end ? c.nb : c.na) : null
  }
  return (start, end) => {
    const x = to(start, false)
    const y = to(end, true)
    return x != null && y != null && y > x ? { start: x, end: y } : null
  }
}

/** A sentence of sentenceOf as a person reads it: no heading, quote or list marker, a table row's cells joined by
 *  ` · `, each mark's words without its brackets, and no code marks. */
export function plainSentence(sentence) {
  let s = String(sentence || '').trim()
  if (s.startsWith('|')) s = s.split('|').map(c => c.trim()).filter(Boolean).join(' · ')
  s = s.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d{1,9}[.)]\s+)+/, '')
  return unbracket(s).replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

/** A sentence of sentenceOf with each mark's `[` and `]` taken off: a `[` and the `]` that balances it, the brackets
 *  inside the words left as written (`[agent-28: "assignment [219] is moot"]`). */
function unbracket(s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] !== '[') { out += s[i++]; continue }
    let depth = 0
    let close = -1
    for (let j = i; j < s.length; j++) {
      if (s[j] === '[') depth++
      else if (s[j] === ']' && --depth === 0) { close = j; break }
    }
    if (close < 0 || s[close + 1] === '(') { out += s[i++]; continue }
    out += s.slice(i + 1, close)
    i = close + 1
  }
  return out
}

// ------------------------------------------------------------------------------------------------ blocks

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/
const HEAD = /^(#{1,6})\s+/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/**
 * The markdown's blocks, each with its offsets: `{type, start, end, from, to, gap, ...}`. `from`..`to` is the content
 * (after a heading's hashes, an item's marker, a quote's `>`); `gap` says a blank line stood before it. Types: para
 * (indent), heading (level), item (indent, marker), quote (indent: a quote inside an item), code, table (rows), rule.
 */
export function blocks(text) {
  const s = String(text || '')
  const lines = []
  let at = 0
  for (const line of s.split('\n')) {
    lines.push({ line, start: at, end: at + line.length })
    at += line.length + 1
  }
  const out = []
  let gap = false
  let i = 0
  const blank = k => k < lines.length && !lines[k].line.trim()
  while (i < lines.length) {
    const L = lines[i]
    const t = L.line
    if (!t.trim()) { gap = out.length > 0; i++; continue }
    const fence = FENCE.exec(t)
    if (fence) {
      let j = i + 1
      while (j < lines.length && !new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(lines[j].line)) j++
      const last = Math.min(j, lines.length - 1)
      out.push({ type: 'code', start: L.start, end: lines[last].end, from: L.start, to: lines[last].end, gap })
      i = last + 1; gap = false; continue
    }
    if (t.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].line) && lines[i + 1].line.includes('-')) {
      let j = i + 2
      while (j < lines.length && lines[j].line.includes('|') && lines[j].line.trim()) j++
      out.push({ type: 'table', start: L.start, end: lines[j - 1].end, from: L.start, to: lines[j - 1].end, gap, rows: lines.slice(i, j).map(x => ({ start: x.start, end: x.end })) })
      i = j; gap = false; continue
    }
    if (RULE.test(t)) { out.push({ type: 'rule', start: L.start, end: L.end, from: L.end, to: L.end, gap }); i++; gap = false; continue }
    const head = HEAD.exec(t)
    if (head) { out.push({ type: 'heading', level: head[1].length, start: L.start, end: L.end, from: L.start + head[0].length, to: L.end, gap }); i++; gap = false; continue }
    if (/^\s*>/.test(t)) {
      // each line of a quote on its own, as a paragraph's lines (a quoted record's lines stay lines)
      const lead = /^\s*>\s?/.exec(t)[0].length
      out.push({ type: 'quote', indent: t.search(/\S/), start: L.start, end: L.end, from: L.start + lead, to: L.end, gap })
      i++; gap = false; continue
    }
    const item = ITEM.exec(t)
    if (item) {
      // the item and its continuation lines: indented further than its marker, no new marker, quote, code or heading,
      // no blank line
      let j = i + 1
      const indent = item[1].length
      const goesOn = k => !blank(k) && !ITEM.exec(lines[k].line) && !FENCE.test(lines[k].line) && !HEAD.test(lines[k].line) && !/^\s*>/.test(lines[k].line)
      while (j < lines.length && goesOn(j) && /^\s+\S/.test(lines[j].line) && lines[j].line.search(/\S/) > indent) j++
      out.push({ type: 'item', indent, marker: item[2], start: L.start, end: lines[j - 1].end, from: L.start + item[0].length, to: lines[j - 1].end, gap })
      i = j; gap = false; continue
    }
    // a line of its own: a line break written inside a paragraph stays a line break (a report's rows, a commit
    // message's lines), with no blank row between the lines; indented, it goes on an item above it
    const lead = t.search(/\S/)
    out.push({ type: 'para', indent: lead, start: L.start, end: L.end, from: L.start + lead, to: L.end, gap })
    i++; gap = false
  }
  return out
}

/** The id of the card a line places at its spot in the reply: the line is only a link to `card:<id>`, such as
 *  `[Edits by day](card:c1a2b3c4d5)`, or null. Elsewhere (a copy, the browser) it reads as a link with the card's title. */
export function cardRef(line) {
  const m = /^\s*\[[^\]\n]*\]\(card:(c[0-9a-f]{8,16})\)\s*$/.exec(String(line || ''))
  return m ? m[1] : null
}

/** The marks that lie inside [from, to), each with its index `i` among all marks (a span, too: {start, end}). */
export const marksWithin = (marks, from, to) => (marks || []).map((m, i) => ({ ...m, i })).filter(m => m.start >= from && m.end <= to)

// ------------------------------------------------------------------------------------------------ inline runs

/** A link's span at the start of `s` (`[words](target)`, the target on one line): [whole, words, target], or null. */
function linkAt(s) {
  const m = /^\[([^\]\n]+)\]\(([^)\n]*)\)/.exec(s)
  return m ? [m[0], m[1], m[2]] : null
}

/**
 * One block's content (text[from..to)) as runs: `{s, b?, it?, code?, link?, dim?, mark?, span?, tag?}` where `mark` is
 * the mark's index among the text's marks, `span` a span's index among `spans` (words a feature draws as a press of its
 * own: an explainer, a heads-up; core/answerview.ts Span), and `tag` the drawing's own (a glyph after a mark's words).
 * Bold, italic and inline code as Claude Code draws them; a mark's words keep their own bold, `*` italic and code, and
 * draw each `_` as written; a link that is no mark reads as its words then its target, as Claude Code draws one. A span
 * lies on plain words, inside one mark's words, or over whole marks, whose runs then carry both ({start, end}: offsets
 * into the text).
 */
export function inline(text, from, to, marks = [], spans = []) {
  const s = String(text || '')
  const mine = marksWithin(marks, from, to)
  const spanned = (spans || []).map((x, i) => ({ ...x, i })).filter(x => x.start >= from && x.end <= to && x.end > x.start)
  const runs = []
  const style = { b: false, it: false }
  const push = (str, extra = {}) => {
    if (!str) return
    const r = { s: str, ...(style.b ? { b: true } : {}), ...(style.it ? { it: true } : {}), ...extra }
    const last = runs[runs.length - 1]
    if (last && same(last, r)) last.s += r.s
    else runs.push(r)
  }
  const word = ch => /[\p{L}\p{N}]/u.test(ch || '')
  // the `_` at k stands in a run of `_` with a letter or digit on each side (CommonMark's intraword rule)
  const intraword = k => { let a = k, e = k; while (s[a - 1] === '_') a--; while (s[e] === '_') e++; return word(s[a - 1]) && word(s[e]) }
  // where the delimiter `d` next stands after `at`, before `end`, as one that can close: -1 when none does
  const closer = (d, at, end) => {
    for (let k = s.indexOf(d, at); k >= 0 && k < end; k = s.indexOf(d, k + 1)) if (d[0] !== '_' || !intraword(k)) return k
    return -1
  }
  // the runs of s[a..end) in the current style, each tagged with `extra`; a mark's words walked in its own span, so
  // a style its words open closes inside them
  const walk = (a, end, extra) => {
    let i = a
    while (i < end) {
      // a span first: one that starts on a mark's bracket covers the mark whole, and the mark's words are the span's too
      const sp = extra.span === undefined ? spanned.find(x => x.start === i && x.end <= end) : null
      if (sp) {
        walk(sp.start, sp.end, { ...extra, span: sp.i })
        i = sp.end
        continue
      }
      const mk = extra.mark === undefined ? mine.find(m => m.start === i) : null
      if (mk) {
        const saved = { ...style }
        walk(mk.start + 1, mk.start + 1 + mk.words.length, { mark: mk.i, ...(extra.span !== undefined ? { span: extra.span } : {}) })
        Object.assign(style, saved)
        i = mk.end
        continue
      }
      const c = s[i]
      if (c === '\n') { push(' ', extra); i++; continue }
      if (c === '\\' && i + 1 < end && /[\\`*_{}[\]()#+\-.!|~>]/.test(s[i + 1])) { push(s[i + 1], extra); i += 2; continue }
      if (c === '`') {
        const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(s.slice(i, end))
        if (m) { push(m[2].replace(/\n/g, ' ').trim() || m[2], { ...extra, code: true }); i += m[0].length; continue }
      }
      // a run of `_` between two letters or digits is part of the word (`chess-nano__goal`), never emphasis; inside a
      // mark, every `_` is a letter, since a mark's words are often a quote or a name (`__init__.py`, `_bin_edges`)
      if (c === '_' && (intraword(i) || extra.mark !== undefined)) { let e = i; while (s[e] === '_') e++; push(s.slice(i, e), extra); i = e; continue }
      // bold and italic close only on the delimiter that opened them, so a `__` never closes a `**`
      if ((c === '*' || c === '_') && s[i + 1] === c) {
        if (style.b === c + c) { style.b = false; i += 2; continue }
        if (!style.b && !/\s/.test(s[i + 2] || ' ') && closer(c + c, i + 2, end) > i + 2) { style.b = c + c; i += 2; continue }
      }
      if (c === '*' || c === '_') {
        if (style.it === c) { style.it = false; i++; continue }
        const close = closer(c, i + 1, end)
        if (!style.it && (c === '*' || !word(s[i - 1])) && close > i + 1 && !/\s/.test(s[i + 1]) && s[close + 1] !== c) { style.it = c; i++; continue }
      }
      if (c === '[' && extra.mark === undefined) {
        const l = linkAt(s.slice(i, end))
        if (l) {
          push(l[1], { ...extra, link: true })
          if (!/^(https?|file):/i.test(l[2])) push(` (${l[2]})`, { ...extra, dim: true })
          i += l[0].length
          continue
        }
      }
      push(c, extra)
      i++
    }
  }
  walk(from, to, {})
  return runs
}

/** Two runs that draw alike (the same mark, or none, the same tag and the same styles), so one can hold both. */
const same = (x, y) => x.mark === y.mark && x.span === y.span && x.tag === y.tag && !!x.b === !!y.b && !!x.it === !!y.it && !!x.code === !!y.code && !!x.link === !!y.link && !!x.dim === !!y.dim

/** The plain words of runs, as drawn. */
export const runsText = runs => runs.map(r => r.s).join('')

/**
 * The runs cut into lines of at most `w` cells, at spaces, a mark's words as plain words are, so a long mark does not
 * leave a short line before it; the glyph after a mark (`tag`) stays with its last word. Only a word wider than a line
 * is cut where the line ends. Each line is a list of runs; the space a line breaks on is dropped.
 */
export function wrapRuns(runs, w) {
  const W = Math.max(8, w)
  // pieces: words and the spaces between them
  const pieces = []
  for (const r of runs) {
    if (r.tag && pieces.length) { pieces[pieces.length - 1].group.push(r); continue }
    for (const part of r.s.split(/( +)/)) if (part) pieces.push({ group: [{ ...r, s: part }], sp: /^ +$/.test(part) })
  }
  // words with no space between them stay together (a mark and the stop after it), as long as they fit on a line
  for (let k = pieces.length - 1; k > 0; k--) {
    const a = pieces[k - 1]
    const b = pieces[k]
    if (!a.sp && !b.sp && textWidth(runsText(a.group)) + textWidth(runsText(b.group)) <= W) { a.group = [...a.group, ...b.group]; pieces.splice(k, 1) }
  }
  const lines = []
  let cur = []
  let n = 0
  const flush = () => {
    while (cur.length && cur[cur.length - 1].sp) cur.pop()
    lines.push(merge(cur.flatMap(p => p.group)))
    cur = []
    n = 0
  }
  for (const p of pieces) {
    const pw = textWidth(runsText(p.group))
    if (p.sp) { if (n === 0) continue; if (n + pw > W) { flush(); continue } cur.push(p); n += pw; continue }
    if (n + pw <= W) { cur.push(p); n += pw; continue }
    if (n > 0 && pw <= W) { flush(); cur.push(p); n = pw; continue }
    // wider than a line: cut it
    let rest = p.group[0].s
    while (rest) {
      const room = W - n
      const chars = [...rest]
      const head = chars.slice(0, Math.max(1, room)).join('')
      cur.push({ group: [{ ...p.group[0], s: head }], sp: false })
      n += textWidth(head)
      rest = chars.slice(Math.max(1, room)).join('')
      if (rest) flush()
    }
  }
  if (cur.length || !lines.length) flush()
  return lines
}

function merge(runs) {
  const out = []
  for (const r of runs) {
    const last = out[out.length - 1]
    if (last && same(last, r)) last.s += r.s
    else out.push({ ...r })
  }
  return out
}

/** A table block's rows of cells, each cell its runs; the separator row is left out. A `|` inside code, a mark or a
 *  link splits no cell. */
export function tableOf(text, block, marks = [], spans = []) {
  const s = String(text || '')
  const rows = []
  for (const [k, r] of (block.rows || []).entries()) {
    if (k === 1) continue
    const line = s.slice(r.start, r.end)
    const cells = []
    let a = r.start + (line.match(/^\s*\|/) ? line.indexOf('|') + 1 : 0)
    const endAt = r.start + line.replace(/\|\s*$/, '').length
    let tick = false
    for (let i = a; i <= endAt; i++) {
      const mk = i < endAt && (marks || []).find(m => i >= m.start && i < m.end)
      if (mk) { i = Math.min(endAt, mk.end) - 1; continue }
      const c = s[i]
      if (c === '`') tick = !tick
      // a link is one span; a bracket that opens no link is a letter of the cell (`[Temporary] Leader`)
      const link = !tick && c === '[' && i < endAt ? linkAt(s.slice(i, endAt)) : null
      if (link) { i += link[0].length - 1; continue }
      if (i === endAt || (c === '|' && !tick && s[i - 1] !== '\\')) {
        let x = a
        let y = i
        while (x < y && /\s/.test(s[x])) x++
        while (y > x && /\s/.test(s[y - 1])) y--
        cells.push(inline(s, x, y, marks, spans))
        a = i + 1
      }
    }
    rows.push(cells)
  }
  return rows
}
