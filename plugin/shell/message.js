// message.js: one message of Claude's as the message layer sees it: its marks, its blocks and how they wrap. No `$`,
// no DOM, no Node: the hooks module, the Node helpers, the browser page and the tests all import it.
//
// A mark is a span of the shown text (the record's `shown`, else its `text`: Claude's markdown as written):
//   cite   {kind: 'cite', start, end, ref, label}       a link to a kernel ref, `[6,543](r1#day=2026-06-18@n)`
//   spark  {kind: 'spark', start, end, ref, values}     a link whose words are `~`, `[~](r4@n)`: a series drawn inline
//   gloss  {kind: 'gloss', start, end, gloss}          a term the observer explains, found by its words: in the text,
//                                                       or in the words of a link, where it is drawn inside the link
// `start` and `end` are string offsets into the shown markdown and cover the mark as written: a cite's or a spark's whole
// link, a gloss's words. Marks are in text order. They never overlap, except a gloss on words inside a link's words.
//
//   linkMarks(text)                  -> the cites and sparks Claude wrote
//   placeMarks(text, glosses, prev)  -> every mark of the text: its links, then each gloss's term where it first stands
//                                       outside a link or code, else in a link's words, else in the words as the person
//                                       reads them (findRead: across a link, on the part outside it); a spark keeps the
//                                       values `prev` resolved for its ref
//   anchorTerm(text, term, taken)    -> where a term stands in a text that may say it in another form: its words, then
//                                       the same words inflected ("claimed" → "claiming"), then its longest word
//   seriesRef(ref)                   -> {query, col} for a spark's ref (r4@n, r4#n), or null
//   sparkChars(values)               -> the sparkline's glyphs, ▁ to ▇, scaled from 0 (or the least value below 0)
//   blocks(text)                     -> the markdown's blocks with their offsets
//   inline(text, from, to, marks)    -> one block's content as runs: words with their style, and each mark as one run
//   wrapRuns(runs, width)            -> the runs cut into lines at spaces; a mark never breaks
//   tableOf(text, block, marks)      -> a table block's cells as runs
import { citeRef, isRef } from './object.js'

/**
 * Each `[words](target)` of a text, as the regex's matches read ({index, 0: whole, 1: words, 2: target}). A target may
 * hold balanced brackets, and a query ref may hold spaces up to its closing bracket, so a ref Claude wrote with a key's
 * words in it, `[202](r11#run_result=won (clean ep)@median)`, is one link and nothing of it spills into the prose (the
 * kernel's refs.link_spans reads the same).
 */
export function linkSpans(text) {
  const s = String(text || '')
  const out = []
  let i = 0
  for (;;) {
    const a = s.indexOf('[', i)
    if (a < 0) break
    const b = s.indexOf(']', a + 1)
    if (b < 0) break
    const words = s.slice(a + 1, b)
    if (!words || words.includes('\n') || words.includes('[') || s[b + 1] !== '(') { i = a + 1; continue }
    let depth = 0
    let j = b + 2
    for (; j < s.length && s[j] !== '\n'; j++) {
      if (s[j] === '(') depth++
      else if (s[j] === ')') { if (depth === 0) break; depth-- }
    }
    if (j >= s.length || s[j] !== ')') { i = a + 1; continue }
    const target = s.slice(b + 2, j)
    if (target.trim() && (!/\s/.test(target.trim()) || /^[qr]\d+#/.test(target.trim()))) {
      const m = [s.slice(a, j + 1), words, target]
      m.index = a
      out.push(m)
      i = j + 1
    } else i = a + 1
  }
  return out
}

/** The text with each link (linkSpans) replaced by `fn(whole, words, target)`: a target with brackets in it is
 *  replaced whole, as the kernel reads it. */
export function mapLinks(text, fn) {
  const s = String(text ?? '')
  let out = ''
  let at = 0
  for (const m of linkSpans(s)) { out += s.slice(at, m.index) + fn(m[0], m[1], m[2]); at = m.index + m[0].length }
  return out + s.slice(at)
}
const SPARK_LABEL = /^\s*~\s*$/

/** Where code stands in markdown: fenced blocks and inline code spans, as [start, end) ranges. */
export function codeRanges(text) {
  const s = String(text || '')
  const out = []
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[`~]*[ \t]*(?=\n|$)|(?![\s\S]))/gm
  for (const m of s.matchAll(fence)) out.push([m.index, m.index + m[0].length])
  const inFence = i => out.some(([a, b]) => i >= a && i < b)
  const span = /(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g
  for (const m of s.matchAll(span)) if (!inFence(m.index)) out.push([m.index, m.index + m[0].length])
  return out.sort((a, b) => a[0] - b[0])
}

const inside = (ranges, a, b) => ranges.some(([x, y]) => a < y && b > x)
// a span that lies within one of the ranges (a link whose words hold a code span is not inside code)
const within = (ranges, a, b) => ranges.some(([x, y]) => a >= x && b <= y)

/** A spark's series: `r4@n` or `r4#n` (the column n of r4's output, in its row order). */
export function seriesRef(ref) {
  const m = /^([qr]\d+)(?:@|#)([A-Za-z_][\w .-]*)$/.exec(String(ref || '').trim())
  if (!m || m[2].includes('=')) return null
  return { query: m[1], col: m[2].trim() }
}

/**
 * The cites and sparks Claude wrote, in text order: each link to a kernel ref or a spark's series, a link to a file's
 * line as editors write it (`[words](server/auth.py:88)`, read as `server/auth.py#L88`) or to a whole file, and a code
 * span that is a file's line alone (`server/auth.py:88-94`), which Claude Code's own habit writes for a place in code.
 */
export function linkMarks(text) {
  const s = String(text || '')
  const code = codeRanges(s)
  const out = []
  const links = linkSpans(s)
  for (const m of links) {
    const target = String(m[2]).trim()
    const start = m.index
    const end = start + m[0].length
    if (within(code, start, end)) continue
    if (SPARK_LABEL.test(m[1])) { if (seriesRef(target) || isRef(target)) out.push({ kind: 'spark', start, end, ref: target, values: null }); continue }
    const ref = citeRef(target)
    if (ref) out.push({ kind: 'cite', start, end, ref, label: labelOf(m[1], ref) })
  }
  // a code span that names a file's line, outside a fenced block and outside a link's words
  const fences = [...s.matchAll(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[`~]*[ \t]*(?=\n|$)|(?![\s\S]))/gm)].map(m => [m.index, m.index + m[0].length])
  const linked = links.map(m => [m.index, m.index + m[0].length])
  for (const [a, b] of code) {
    if (inside(fences, a, b) || inside(linked, a, b)) continue
    const inner = s.slice(a, b).replace(/^`+|`+$/g, '').trim()
    const ref = citeRef(inner, { loose: true })
    if (ref) out.push({ kind: 'cite', start: a, end: b, ref, label: inner, code: true })
  }
  return out.sort((x, y) => x.start - y.start)
}

// a citation's words that name nothing: a pronoun, or a sign such as an arrow
const VAGUE = /^(here|there|this|that|it|link|source|see|see here|see this|this line|these lines|this file)$/i

/** A citation's words, without its markdown; one whose words name nothing (a pronoun, an arrow) is named by its
 *  place, as editors write it (`plugin/hooks/path.ts:12`). */
function labelOf(words, ref) {
  const w = plainWords(words).trim()
  return /[\p{L}\p{N}]/u.test(w) && !VAGUE.test(w) ? w : String(ref).replace(/#L(\d+)(?:-L?(\d+))?.*$/, (_, a, b) => `:${a}${b && b !== a ? `-${b}` : ''}`).replace(/^obj:/, '')
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Markdown's words as a reader sees them: a code span's text as written (underscores and stars kept, its backticks
 * gone), emphasis markers dropped where they wrap words (`**a**`, `_a_`), and an underscore or a star inside or beside
 * a word that is no emphasis kept (`add_csv_export`, `"*"`).
 */
export function plainWords(md) {
  const s = String(md ?? '')
  const emphasisOff = t => t
    .replace(/(\*{1,3})(?=\S)([^*\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}_])(_{1,3})(?=\S)([^_\n]*?\S)\2(?![\p{L}\p{N}_])/gu, '$1$3')
    .replace(/`+/g, '')
  let out = ''
  let last = 0
  for (const m of s.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) {
    out += emphasisOff(s.slice(last, m.index)) + m[2]
    last = m.index + m[0].length
  }
  return out + emphasisOff(s.slice(last))
}

/** Markdown as one line of plain words: each link as its words, a heading's or a quote's marker dropped, then
 *  plainWords, the spaces made one. */
export const lineOf = md => plainWords(String(md ?? '').replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1').replace(/^[ \t]*(#{1,6}[ \t]+|>[ \t]?)/gm, '')).replace(/\s+/g, ' ').trim()

/** A gloss's term as the observer wrote it, without the backticks of a code span (`hydrate()` is hydrate()). */
const termOf = term => String(term || '').replace(/`/g, '').trim()

/**
 * Where a gloss's term first stands: a whole-word match outside links and code, the exact case first. A term may stand
 * as code, whole (`pytest-xdist`) or in part of its words (`AbovePrompt` hook): the match then takes in the code
 * spans it holds, backticks and all.
 */
export function findTerm(text, term, taken = []) {
  const t = termOf(term)
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const code = codeRanges(s)
  // link spans and other marks block a term; a code span blocks it unless the match holds the whole span
  const blocked = taken.map(m => [m.start, m.end])
  for (const m of linkSpans(s)) blocked.push([m.index, m.index + m[0].length])
  const edge = '(?<![\\p{L}\\p{N}_`])'
  const tail = '(?![\\p{L}\\p{N}_`])'
  const body = t.split(/\s+/).map(w => '`?' + escapeRe(w) + '`?').join('\\s+')
  for (const flags of ['gu', 'giu']) {
    const re = new RegExp(edge + body + tail, flags)
    for (const m of s.matchAll(re)) {
      const a = m.index
      const b = a + m[0].length
      if (inside(blocked, a, b)) continue
      // a code span it touches must lie whole inside it, and a backtick it holds must open or close such a span
      const touched = code.filter(([x, y]) => a < y && b > x)
      if (touched.some(([x, y]) => x < a || y > b)) continue
      const ticks = [...m[0].matchAll(/`/g)].map(x => a + x.index)
      if (ticks.some(i => !touched.some(([x, y]) => i === x || i === y - 1))) continue
      return { start: a, end: b }
    }
  }
  return null
}

/**
 * Where a gloss's term stands in the words of a link (a citation's words, `[the claimer](q19#n)`), the exact case first:
 * {start, end} in the text, inside the link's brackets. The explain is drawn there, inside the link. Null when no link's
 * words hold it, or only where `taken` (another explain) already stands.
 */
export function findInLink(text, term, taken = []) {
  const t = termOf(term)
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const code = codeRanges(s)
  const blocked = taken.filter(m => m.kind === 'gloss').map(m => [m.start, m.end])
  const body = t.split(/\s+/).map(w => '`?' + escapeRe(w) + '`?').join('[`\\s]+')
  for (const flags of ['gu', 'giu']) {
    const re = new RegExp('(?<![\\p{L}\\p{N}_`])' + body + '(?![\\p{L}\\p{N}_`])', flags)
    for (const m of linkSpans(s)) {
      const from = m.index + 1
      if (within(code, m.index, m.index + m[0].length)) continue
      for (const hit of String(m[1]).matchAll(re)) {
        const a = from + hit.index
        const b = a + hit[0].length
        if (!inside(blocked, a, b)) return { start: a, end: b }
      }
    }
  }
  return null
}


/**
 * The markdown as the person reads it, with where each of its characters stands in the markdown: a link as its words, a
 * code span without its backticks, emphasis markers and escapes dropped. `at[k]` is the markdown offset of `text[k]`.
 */
export function readable(md) {
  const s = String(md || '')
  const links = linkSpans(s)
  const code = codeRanges(s)
  let text = ''
  const at = []
  const add = (ch, i) => { text += ch; at.push(i) }
  const word = c => /[\p{L}\p{N}]/u.test(c || '')
  let i = 0
  while (i < s.length) {
    const l = links.find(m => m.index === i)
    if (l) {
      // a link's words, each where it stands inside the brackets
      for (let k = 0; k < l[1].length; k++) if (!/[`*]/.test(l[1][k])) add(l[1][k], i + 1 + k)
      i += l[0].length
      continue
    }
    const c = code.find(([a]) => a === i)
    if (c) {
      // a code span's text as written, its backticks gone
      let a = c[0]
      let b = c[1]
      while (a < b && s[a] === '`') a++
      while (b > a && s[b - 1] === '`') b--
      for (let k = a; k < b; k++) add(s[k], k)
      i = c[1]
      continue
    }
    const ch = s[i]
    if (ch === '\\' && /[\\`*_{}[\]()#+\-.!|~>]/.test(s[i + 1] || '')) { add(s[i + 1], i + 1); i += 2; continue }
    if (ch === '*' || ch === '`' || (ch === '_' && !(word(s[i - 1]) && word(s[i + 1])))) { i++; continue }
    add(ch, i)
    i++
  }
  return { text, at }
}

/**
 * Where a term stands in the words as the person reads them, when the markdown says them with a link in between ("5 of
 * the 13 files in plugin/prompts" is `[5](r7#n) of the 13 files in \`plugin/prompts\``): the term is found in
 * readable(text) and mapped back to the markdown. A mark never stands on a link or on another mark, so the mark takes
 * the longest part of the match outside them, with each code span it touches whole. Null when no such part holds a
 * word.
 */
export function findRead(text, term, taken = []) {
  const t = termOf(term)
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const r = readable(s)
  const code = codeRanges(s)
  const blocked = taken.map(m => [m.start, m.end])
  for (const m of linkSpans(s)) blocked.push([m.index, m.index + m[0].length])
  const body = t.split(/\s+/).map(escapeRe).join('\\s+')
  for (const flags of ['gu', 'giu']) {
    const re = new RegExp('(?<![\\p{L}\\p{N}_])' + body + '(?![\\p{L}\\p{N}_])', flags)
    for (const m of r.text.matchAll(re)) {
      // the match cut into parts at each link or mark it crosses, each part [first, last + 1) in the markdown
      const parts = []
      let cur = null
      for (const i of r.at.slice(m.index, m.index + m[0].length)) {
        if (inside(blocked, i, i + 1)) { cur = null; continue }
        if (!cur) { cur = { a: i, b: i + 1, n: 0 }; parts.push(cur) }
        cur.b = i + 1
        cur.n++
      }
      const spans = parts.map(p => {
        let a = p.a
        let b = p.b
        // each code span it touches, whole
        for (const [x, y] of code) if (a < y && b > x) { a = Math.min(a, x); b = Math.max(b, y) }
        while (a < b && /[\s,.;:!?()\-–—]/.test(s[a])) a++
        while (b > a && /[\s,.;:!?()\-–—]/.test(s[b - 1])) b--
        return { start: a, end: b, n: p.n }
      }).filter(p => p.end > p.start && /[\p{L}\p{N}]/u.test(s.slice(p.start, p.end)) && !inside(blocked, p.start, p.end))
      if (spans.length) {
        const best = spans.reduce((x, y) => (y.n > x.n ? y : x))
        return { start: best.start, end: best.end }
      }
    }
  }
  return null
}

// words that never carry a term on their own: a term's other words are tried before these
const STOP = new Set('a an and are as at be by for from in into is it its of on or per than that the their them then this to vs versus via was were with without'.split(' '))

/** A word's stem for matching forms of one word: "claimed", "claiming", "claimer" and "claims" all give "claim";
 *  "approval" and "approved" give "approv". Crude on purpose: it is used only to find a term again in a rewrite. */
export function stemOf(word) {
  let w = String(word || '').toLowerCase().replace(/['’]s$/, '')
  if (w.length <= 3) return w
  for (const [suf, to] of [['ational', 'ate'], ['ations', 'ate'], ['ation', 'ate'], ['ingly', ''], ['ings', ''], ['ing', ''], ['iers', 'y'], ['ies', 'y'], ['ied', 'y'], ['ier', 'y'], ['ers', ''], ['er', ''], ['ed', ''], ['es', ''], ['s', ''], ['ly', ''], ['ments', ''], ['ment', ''], ['als', ''], ['al', '']]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      if (suf === 's' && /(ss|us|is)$/.test(w)) continue
      w = w.slice(0, w.length - suf.length) + to
      break
    }
  }
  // stopp → stop, but keep ll, ss and zz (call, pass, buzz)
  if (/([b-df-hj-km-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1)
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

const WORD = /[\p{L}\p{N}]+/gu

/**
 * Where a gloss's term stands in a text that may say it in another form (a rewrite of the message the term came from):
 *   1. its words as written (findTerm);
 *   2. the same words in another form, in a row: "claimed" finds "claiming", "self-approval" finds "self-approved";
 *   3. its longest word that is not a small word, in any form: "fixture scope" finds "scope".
 * Never inside a link, code or another mark. Returns {start, end, how} (how: 'term' | 'form' | 'word'), or null.
 */
export function anchorTerm(text, term, taken = []) {
  const exact = findTerm(text, term, taken)
  if (exact) return { ...exact, how: 'term' }
  const t = String(term || '').trim()
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const blocked = [...codeRanges(s), ...taken.map(m => [m.start, m.end])]
  for (const m of linkSpans(s)) blocked.push([m.index, m.index + m[0].length])
  const words = [...s.matchAll(WORD)].filter(m => !inside(blocked, m.index, m.index + m[0].length)).map(m => ({ a: m.index, b: m.index + m[0].length, stem: stemOf(m[0]), gap: '' }))
  for (let i = 1; i < words.length; i++) words[i].gap = s.slice(words[i - 1].b, words[i].a)
  const want = (t.match(WORD) || []).map(stemOf)
  if (!want.length) return null
  // the term's words in a row, in any form, with only spaces or hyphens between them
  for (let i = 0; i + want.length <= words.length; i++) {
    let ok = true
    for (let k = 0; k < want.length && ok; k++) ok = words[i + k].stem === want[k] && (k === 0 || /^[\s-]{1,2}$/.test(words[i + k].gap))
    if (ok) return { start: words[i].a, end: words[i + want.length - 1].b, how: 'form' }
  }
  if (want.length < 2) return null
  // the term's longest word that carries meaning alone, in any form
  const own = [...new Set((t.match(WORD) || []).filter(w => w.length >= 4 && !STOP.has(w.toLowerCase())))].sort((x, y) => y.length - x.length)
  for (const w of own) {
    const hit = words.find(x => x.stem === stemOf(w))
    if (hit) return { start: hit.a, end: hit.b, how: 'word' }
  }
  return null
}

/**
 * Every mark of the text: the links Claude wrote, then each gloss placed by its term. `glosses` is the record's
 * `{id: {term, ...}}`. A term stands where it first stands outside links and code (findTerm), else in a link's words
 * (findInLink), where its explain is drawn inside the link, else in the words as the person reads them (findRead). A rewrite (`original`: the text it was written from) may say
 * a term in another form, so the term is found again in it (anchorTerm). A gloss whose term the text does not hold gets
 * no mark: the record keeps it, and it stands on its words again when a text that holds them shows (the original after
 * a squeeze). `prev` (the marks before a change of the text) gives each spark the values already resolved for its ref.
 */
export function placeMarks(text, glosses = {}, prev = [], { original = null } = {}) {
  const marks = linkMarks(text)
  for (const m of marks) {
    if (m.kind !== 'spark') continue
    const old = (prev || []).find(p => p.kind === 'spark' && p.ref === m.ref && Array.isArray(p.values))
    if (old) m.values = old.values
  }
  // the heads-up first: its words are often a longer phrase that holds an explainer's term ("more than a hundred
  // different network ranges" holds "network ranges"), and a mark never stands on another's words, so the explainer
  // then stands where its term is said again, and both show
  const order = Object.entries(glosses || {}).sort(([, x], [, y]) => (y?.kind === 'heads') - (x?.kind === 'heads'))
  for (const [id, g] of order) {
    const term = g && g.term
    const at = original == null ? findTerm(text, term, marks) : anchorTerm(text, term, marks)
    if (at) { marks.push({ kind: 'gloss', start: at.start, end: at.end, gloss: id, ...(at.how && at.how !== 'term' ? { anchor: at.how } : {}) }); continue }
    // in a link's words; else in the words as the person reads them, across a link or a code span (findRead)
    const inLink = findInLink(text, term, marks) ?? findRead(text, term, marks)
    if (inLink) marks.push({ kind: 'gloss', start: inLink.start, end: inLink.end, gloss: id })
  }
  return marks.sort((a, b) => a.start - b.start)
}

// ------------------------------------------------------------------------------------------------ the sparkline

const SPK = '▁▂▃▄▅▆▇'

/** Values binned to at most `max` points (the mean of each bin), so a long series still reads as a word. */
export function binned(values, max = 24) {
  const v = (values || []).map(x => (typeof x === 'number' && Number.isFinite(x) ? x : null))
  if (v.length <= max) return v
  const out = []
  for (let i = 0; i < max; i++) {
    const a = Math.floor((i * v.length) / max)
    const b = Math.max(a + 1, Math.floor(((i + 1) * v.length) / max))
    const xs = v.slice(a, b).filter(x => x != null)
    out.push(xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
  }
  return out
}

/** The sparkline's glyphs: ▁ (least) to ▇ (most, never touching the row above), from 0 or the least value below it. */
export function sparkChars(values, max = 24) {
  const v = binned(values, max)
  const nums = v.filter(x => x != null)
  if (!nums.length) return '~'
  const lo = Math.min(0, ...nums)
  const hi = Math.max(...nums)
  return v.map(x => (x == null ? ' ' : SPK[Math.max(0, Math.min(6, hi === lo ? 3 : Math.ceil(((x - lo) / (hi - lo)) * 7) - 1))])).join('')
}

// ------------------------------------------------------------------------------------------------ blocks

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/
const HEAD = /^(#{1,6})\s+/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/**
 * The markdown's blocks, each with its offsets: `{type, start, end, from, to, gap, ...}`. `from`..`to` is the content
 * (after a heading's hashes, an item's marker, a quote's `>`); `gap` says a blank line stood before it. Types: para,
 * heading (level), item (indent, marker), quote, code, table, rule.
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
      let j = i
      while (j < lines.length && /^\s*>/.test(lines[j].line)) j++
      const lead = /^\s*>\s?/.exec(t)[0].length
      out.push({ type: 'quote', start: L.start, end: lines[j - 1].end, from: L.start + lead, to: lines[j - 1].end, gap })
      i = j; gap = false; continue
    }
    const item = ITEM.exec(t)
    if (item) {
      // the item and its continuation lines: indented further than its marker, no new marker, no blank line
      let j = i + 1
      const indent = item[1].length
      while (j < lines.length && !blank(j) && !ITEM.exec(lines[j].line) && !FENCE.test(lines[j].line) && !HEAD.test(lines[j].line) && /^\s+\S/.test(lines[j].line) && lines[j].line.search(/\S/) > indent) j++
      out.push({ type: 'item', indent, marker: item[2], start: L.start, end: lines[j - 1].end, from: L.start + item[0].length, to: lines[j - 1].end, gap })
      i = j; gap = false; continue
    }
    // a line of its own: a line break written inside a paragraph stays a line break (a report's rows, a commit
    // message's lines, a manager's labelled lines), with no blank row between the lines
    out.push({ type: 'para', start: L.start, end: L.end, from: L.start, to: L.end, gap })
    i++; gap = false
  }
  return out
}

/** The marks that lie inside [from, to). */
export const marksIn = (marks, from, to) => (marks || []).map((m, i) => ({ ...m, i })).filter(m => m.start >= from && m.end <= to)

// ------------------------------------------------------------------------------------------------ inline runs

/**
 * One block's content (text[from..to)) as runs: `{s, b?, it?, code?, link?, mark?, within?, tag?}` where `mark` is the mark's
 * index in the record's marks, and `tag` the healing pass's glyph after a citation's words (HEAL_TAG). Bold, italic and inline code as Claude Code draws them; a link that is no mark reads as
 * its words then its target, as Claude Code draws one. An explain on words inside a link's words is a run of its own
 * between the link's runs, `within` the link's mark (or `link`, for a link that is no mark). (A paragraph's lines are
 * blocks of their own, so a line break stays one.)
 */
export function inline(text, from, to, marks = []) {
  const s = String(text || '')
  const mine = marksIn(marks, from, to)
  const runs = []
  const style = { b: false, it: false }
  const push = (str, extra = {}) => {
    if (!str) return
    const r = { s: str, ...(style.b ? { b: true } : {}), ...(style.it ? { it: true } : {}), ...extra }
    const last = runs[runs.length - 1]
    if (last && last.mark === undefined && r.mark === undefined && !!last.b === !!r.b && !!last.it === !!r.it && !!last.code === !!r.code && !!last.link === !!r.link) last.s += r.s
    else runs.push(r)
  }
  // a link's words with the explains that stand inside them: the words before, between and after each one as the link's
  // runs (`own`), each explain a run of its own
  const linkWords = (a, b, own, extra = {}) => {
    const inner = mine.filter(m => m.kind === 'gloss' && m.start >= a && m.end <= b)
    if (!inner.length) return false
    let at = a
    for (const g of inner) {
      push(plainWords(s.slice(at, g.start)), own)
      push(plainWords(s.slice(g.start, g.end)).replace(/\s+/g, ' '), { mark: g.i, ...extra })
      at = g.end
    }
    push(plainWords(s.slice(at, b)), own)
    return true
  }
  let i = from
  while (i < to) {
    const mk = mine.find(m => m.start === i)
    if (mk && mk.kind === 'cite' && s[mk.start] === '[') {
      const close = s.indexOf('](', mk.start)
      if (close > mk.start && close < mk.end && linkWords(mk.start + 1, close, { mark: mk.i }, { within: mk.i })) { if (HEAL_TAG[mk.heal]) push(HEAL_TAG[mk.heal], { mark: mk.i, tag: mk.heal }); i = mk.end; continue }
    }
    if (mk) {
      const raw = s.slice(mk.start, mk.end)
      const asCode = mk.kind === 'gloss' && /^`[^`]*`$/.test(raw)
      const words = mk.kind === 'gloss' ? raw.replace(/`+/g, '').replace(/\s+/g, ' ') : mk.kind === 'spark' ? sparkChars(mk.values || []) : mk.label
      push(words, { mark: mk.i, ...(asCode ? { code: true } : {}) })
      if (mk.kind === 'cite' && HEAL_TAG[mk.heal]) push(HEAL_TAG[mk.heal], { mark: mk.i, tag: mk.heal })
      i = mk.end
      continue
    }
    const c = s[i]
    if (c === '\n') { push(' '); i++; continue }
    if (c === '\\' && i + 1 < to && /[\\`*_{}[\]()#+\-.!|~>]/.test(s[i + 1])) { push(s[i + 1]); i += 2; continue }
    if (c === '`') {
      const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(s.slice(i, to))
      if (m) { push(m[2].replace(/\n/g, ' ').trim() || m[2], { code: true }); i += m[0].length; continue }
    }
    if ((c === '*' || c === '_') && s[i + 1] === c) {
      const close = s.indexOf(c + c, i + 2)
      if (close > i + 2 && close < to && (style.b || !/\s/.test(s[i + 2]))) { style.b = !style.b; i += 2; continue }
      if (style.b) { style.b = false; i += 2; continue }
    }
    if (c === '*' || (c === '_' && !/[\p{L}\p{N}]/u.test(s[i - 1] || ''))) {
      const close = s.indexOf(c, i + 1)
      if (style.it) { style.it = false; i++; continue }
      if (close > i + 1 && close < to && !/\s/.test(s[i + 1]) && s[close + 1] !== c) { style.it = true; i++; continue }
    }
    if (c === '[') {
      const m = linkSpans(s.slice(i, to))[0]
      if (m && m.index === 0) {
        if (!linkWords(i + 1, i + 1 + m[1].length, { link: true }, { link: true })) push(m[1], { link: true })
        if (!/^(https?|file):/i.test(m[2])) push(` (${m[2]})`, { dim: true })
        i += m[0].length
        continue
      }
    }
    push(c)
    i++
  }
  return runs
}

/** A run's width in cells (a wide character counts two). */
export function width(str) {
  let n = 0
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0)
    n += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff))) ? 2 : 1
  }
  return n
}

/**
 * The runs cut into lines of at most `w` cells, at spaces. A mark (`mark` set) is kept whole on one line; a mark wider
 * than a line breaks at its spaces as plain words do, each piece still the mark. Only a word wider than a line is cut
 * where the line ends. Each line is a list of runs; the space a line breaks on is dropped.
 */
export function wrapRuns(runs, w) {
  const W = Math.max(8, w)
  // pieces: words with their spaces, a mark whole when it fits on a line
  const pieces = []
  for (const r of runs) {
    if (r.mark !== undefined && width(r.s) <= W) { pieces.push({ ...r, sp: false }); continue }
    for (const part of r.s.split(/( +)/)) if (part) pieces.push({ ...r, s: part, sp: /^ +$/.test(part) })
  }
  const lines = []
  let cur = []
  let n = 0
  const flush = () => {
    while (cur.length && cur[cur.length - 1].sp) cur.pop()
    lines.push(merge(cur))
    cur = []
    n = 0
  }
  for (const p of pieces) {
    const pw = width(p.s)
    if (p.sp) { if (n === 0) continue; if (n + pw > W) { flush(); continue } cur.push(p); n += pw; continue }
    if (n + pw <= W) { cur.push(p); n += pw; continue }
    if (n > 0 && pw <= W) { flush(); cur.push(p); n = pw; continue }
    // wider than a line: cut it
    let rest = p.s
    while (rest) {
      const room = W - n
      const chars = [...rest]
      const head = chars.slice(0, Math.max(1, room)).join('')
      cur.push({ ...p, s: head })
      n += width(head)
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
    const { sp, ...x } = r
    const last = out[out.length - 1]
    if (last && last.mark === undefined && x.mark === undefined && !!last.b === !!x.b && !!last.it === !!x.it && !!last.code === !!x.code && !!last.link === !!x.link && !!last.dim === !!x.dim) last.s += x.s
    else if (last && last.mark !== undefined && x.mark === last.mark && last.tag === x.tag) last.s += x.s
    else out.push({ ...x })
  }
  return out
}

/** A table block's rows of cells, each cell its runs; the separator row is left out. */
export function tableOf(text, block, marks = []) {
  const s = String(text || '')
  const rows = []
  for (const [k, r] of (block.rows || []).entries()) {
    if (k === 1) continue
    const line = s.slice(r.start, r.end)
    // cells: split on | outside code and links
    const cells = []
    let a = r.start + (line.match(/^\s*\|/) ? line.indexOf('|') + 1 : 0)
    const endAt = r.start + line.replace(/\|\s*$/, '').length
    let depth = 0
    let tick = false
    for (let i = a; i <= endAt; i++) {
      const c = s[i]
      if (c === '`') tick = !tick
      if (!tick && c === '[') depth++
      if (!tick && c === ')' && depth > 0 && s[i - 1] !== '\\') depth = Math.max(0, depth - 1)
      if (i === endAt || (c === '|' && !tick && depth === 0 && s[i - 1] !== '\\')) {
        let x = a
        let y = i
        while (x < y && /\s/.test(s[x])) x++
        while (y > x && /\s/.test(s[y - 1])) y--
        cells.push(inline(s, x, y, marks))
        a = i + 1
      }
    }
    rows.push(cells)
  }
  return rows
}

/** The plain words of runs, as drawn. */
export const runsText = runs => runs.map(r => r.s).join('')

// ------------------------------------------------------------------------------------------------ the record

/** The text a record shows now: `shown` after a squeeze, else Claude's `text`. */
export const shownOf = rec => (rec && typeof rec.shown === 'string' ? rec.shown : String(rec?.text ?? ''))

/** A new record for one of Claude's messages (CONTRACT 1). */
export function newRecord({ row, session, text, at }) {
  const rec = { v: 1, row: String(row), session: String(session || ''), at: at || null, text: String(text ?? ''), shown: null, marks: [], glosses: {}, verbs: {}, objects: [], final: false }
  rec.marks = placeMarks(rec.text, {}, [])
  return rec
}

/** The record with its marks placed again on the text it shows (after a squeeze, or new glosses). */
export function remark(rec) {
  return { ...rec, marks: placeMarks(shownOf(rec), rec.glosses || {}, rec.marks || [], { original: typeof rec.shown === 'string' ? rec.text : null }) }
}

/** The record for a message whose words are `text`: the kept record when its words are the same (its marks placed
 *  again when an earlier version left an explain after the text, so it stands on its words), else a new one that keeps
 *  the kept one's glosses, verbs and objects (a summary row, a resumed session). */
export function recordFor(kept, { row, session, text, at }) {
  if (kept && kept.text === String(text ?? '')) return (kept.marks || []).some(m => m && m.loose) ? remark(kept) : kept
  const rec = newRecord({ row, session, text, at: at || kept?.at })
  if (!kept) return rec
  return remark({ ...rec, ...(kept.uuid ? { uuid: kept.uuid } : {}), glosses: kept.glosses || {}, verbs: kept.verbs || {}, objects: kept.objects || [], final: !!kept.final })
}

const VERB_KEYS = ['v', 's']
// a string's words on one line, cut to `n` characters only where a caller gives `n`
const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
// the same, with … where it is cut
const clip = (v, n) => { const t = str(v); return Array.from(t).length <= n ? t : Array.from(t).slice(0, n - 1).join('').trimEnd() + '…' }

/**
 * The observer's verbs as the record keeps them: each of v and s, lit only when the observer gave it, with its note of
 * 2–4 words; v's proposals (at most 2), s's chips (dimensions with levels, at most 3).
 * Accepts the observer's short form (a verb present = lit) and the record's own form ({lit, note, ...}).
 */
export function verbsOf(out) {
  const res = {}
  const src = out && typeof out === 'object' ? out : {}
  for (const k of VERB_KEYS) {
    const v = src[k]
    if (!v || typeof v !== 'object' || v.lit === false) continue
    const note = str(v.note, 40)
    const r = { lit: true, note }
    if (k === 'v') {
      // each name whole: it is what v asks Claude to draw, and the line under the message cuts it to its width, with …
      r.proposals = (Array.isArray(v.proposals) ? v.proposals : []).map(p => clip(typeof p === 'string' ? p : p?.title, 160)).filter(Boolean).slice(0, 2)
      if (!r.proposals.length && !note) continue
    }
    if (k === 's') {
      // where the answer stands on the squeeze's fixed chips, by a level's name: {interpret: 'facts only'}
      if (v.at && typeof v.at === 'object' && !Array.isArray(v.at)) {
        r.at = {}
        for (const [id, lv] of Object.entries(v.at).slice(0, 6)) if (typeof lv === 'string' || Number.isInteger(lv)) r.at[str(id, 24)] = typeof lv === 'string' ? str(lv, 24).toLowerCase() : lv
      }
      r.chips = (Array.isArray(v.chips) ? v.chips : []).filter(c => c && typeof c === 'object').slice(0, 3).map((c, i) => {
        const levels = (Array.isArray(c.levels) ? c.levels : []).map(l => str(l, 24)).filter(Boolean).slice(0, 5)
        const level = Number.isInteger(c.level) && c.level >= 0 && c.level < levels.length ? c.level : Math.max(0, levels.length - 1)
        return { id: str(c.id, 20) || str(c.name, 20).toLowerCase().replace(/[^a-z0-9]+/g, '-') || `d${i + 1}`, name: str(c.name, 24) || `dimension ${i + 1}`, levels, level }
      }).filter(c => c.levels.length >= 2)
    }
    if (!r.note) r.note = k === 'v' ? `${r.proposals.length} view${r.proposals.length === 1 ? '' : 's'} ready` : ''
    // s may carry only where the answer stands on its chips: kept, and not lit
    if (!r.note && k === 's' && r.at && Object.keys(r.at).length) { res[k] = { ...r, lit: false }; continue }
    if (!r.note) continue
    res[k] = r
  }
  return res
}

/**
 * The observer's glosses as the record keeps them, `{g1: {term, title, body, here, program, refs}}`: each a term found
 * in the text or in a link's words (a term the text does not hold is dropped, so no gloss points at nothing), none whose
 * term is in `skip` (terms already explained in this session).
 */
export function glossesOf(list, text, skip = []) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const seen = new Set((skip || []).map(norm))
  const out = {}
  let n = 0
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || typeof g !== 'object') continue
    const term = str(termOf(g.term))
    if (!term || seen.has(norm(term)) || !(findTerm(text, term) || findInLink(text, term) || findRead(text, term))) continue
    seen.add(norm(term))
    const refs = (Array.isArray(g.refs) ? g.refs : []).filter(r => typeof r === 'string' && isRef(r))
    out[`g${++n}`] = { term, title: str(g.title) || term, body: str(g.body), here: str(g.here), program: typeof g.program === 'string' ? g.program : '', refs }
  }
  return out
}

/**
 * The observer's heads-up as the record keeps it, `{h1: {kind: 'heads', term, title, bullets, todo, refs}}`: one at most,
 * placed on its term like a gloss (a term the text does not hold is dropped, so it never points at nothing).
 */
export function headsOf(item, text) {
  if (!item || typeof item !== 'object') return {}
  const term = str(termOf(item.term))
  const bullets = (Array.isArray(item.bullets) ? item.bullets : []).map(b => str(b)).filter(Boolean)
  if (!term || !bullets.length || !(findTerm(text, term) || findInLink(text, term) || findRead(text, term))) return {}
  const refs = [...new Set(bullets.flatMap(b => [...b.matchAll(/\]\(([^)\n]+)\)/g)].map(m => citeRef(m[1])).filter(Boolean)))]
  return { h1: { kind: 'heads', term, title: str(item.title) || term, bullets, todo: str(item.todo), refs } }
}

/** The record with what the observer gave for it: its lit verbs and its glosses, the marks placed again. */
export function withObserver(rec, { verbs, glosses } = {}) {
  return remark({ ...rec, verbs: verbs || {}, glosses: glosses || {} })
}

// ------------------------------------------------------------------------------------------------ healing

/** A text's key for the healing pass: FNV-1a over its UTF-16 units, as hex, the same in Node and the browser. */
export function textKey(text) {
  const s = String(text ?? '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

const citesOf = rec => (Array.isArray(rec?.marks) ? rec.marks : []).filter(m => m && m.kind === 'cite' && !m.code)

/** What the healing pass found in the text a record shows now, as {key, of, version, changes}, or null. A record keeps
 *  the pass of each text it showed (`heals`, by text key), so a squeeze's version and the original each keep their
 *  own checks as the person moves between them; `heal` is the one pass a record kept before that, for one text. */
export function healOf(rec) {
  const key = textKey(shownOf(rec))
  const kept = rec && rec.heals && typeof rec.heals === 'object' ? rec.heals[key] : null
  if (kept && typeof kept === 'object') return { ...kept, key }
  return rec && rec.heal && rec.heal.key === key ? rec.heal : null
}

/** The record with a pass's result kept for the text it read (`key`), beside the passes of its other texts. */
export function withHeal(rec, key, result) {
  const heals = { ...(rec.heals && typeof rec.heals === 'object' ? rec.heals : {}) }
  // a pass kept as `heal` before `heals` was kept with the rest, so it is not lost
  if (rec.heal && typeof rec.heal.key === 'string' && !heals[rec.heal.key]) { const { key: k, ...was } = rec.heal; heals[k] = was }
  const { key: _k, ...r } = result || {}
  heals[key] = r
  const { heal: _old, ...rest } = rec
  return { ...rest, heals }
}

/** The record with the citation of `ref` kept as gone in its shown text's result (its card found the place gone after
 *  the pass checked it: `gone` says what is missing, `no query r21`), or null when nothing changes: no pass has read the
 *  text yet (its pass finds the place gone itself), no citation opens `ref`, or it is gone already. */
export function withGone(rec, ref, gone) {
  const h = healOf(rec)
  if (!h || !Array.isArray(h.changes)) return null
  const j = h.changes.findIndex(c => c && (c.to === ref || (!c.to && c.ref === ref)))
  if (j < 0 || h.changes[j].how === 'gone') return null
  const why = `the cited place is gone${gone ? ` (${gone})` : ''}`
  return withHeal(rec, h.key, { ...h, changes: h.changes.map((c, i) => (i === j ? { ...c, state: 'quiet', how: 'gone', why } : c)) })
}

/** Whether a record's shown text has citations the healing pass reads, and no pass has healed this text yet. */
export function needsHeal(rec) {
  return citesOf(rec).length > 0 && !healOf(rec)
}

/** The text the healing pass reads (the kernel's `thimble heal`): the shown text with each citation's target written
 *  as the ref its mark reads (`auth.py:88` as `auth.py#L88`), so the kernel and the drawing read the same place. */
export function healInput(rec) {
  const s = shownOf(rec)
  let out = ''
  let at = 0
  for (const m of citesOf(rec)) {
    const close = s.indexOf('](', m.start)
    if (s[m.start] !== '[' || close < 0 || close > m.end) continue
    out += s.slice(at, m.start) + s.slice(m.start, close + 2) + m.ref + ')'
    at = m.end
  }
  return out + s.slice(at)
}

/**
 * The record as its healing pass left it, for a drawing (no write): each citation the pass re-pointed opens its new
 * place (`ref`, with `wrote` the ref as written, `heal: 'moved'`), one it kept as written is `heal: 'kept'` (drawn as
 * any citation), one it unwrapped is quiet (`heal: 'quiet'`, drawn grey, `why`), one
 * whose place does not exist is `heal: 'gone'` (a citation that failed, `why` says what is missing), one the cited place
 * contradicts is `heal: 'bad'` with `why`; while a pass runs (`checking`) every citation is
 * `heal: 'checking'`. The changes match the marks in order, by their link as written or their ref.
 */
export function healedRecord(rec, { checking = false } = {}) {
  if (!citesOf(rec).length) return rec
  const text = shownOf(rec)
  const h = healOf(rec)
  if (h && Array.isArray(h.changes)) {
    const used = new Set()
    const marks = rec.marks.map(m => {
      if (!m || m.kind !== 'cite' || m.code) return m
      const raw = text.slice(m.start, m.end)
      const j = h.changes.findIndex((c, k) => !used.has(k) && c && (`[${c.label}](${c.ref})` === raw || c.ref === m.ref))
      if (j < 0) return m
      used.add(j)
      const c = h.changes[j]
      if (c.state === 'contradicted') return { ...m, heal: 'bad', why: String(c.why || '') }
      if (c.state === 'quiet') return { ...m, heal: c.how === 'gone' ? 'gone' : 'quiet', why: String(c.why || '') }
      if (c.to && c.to !== c.ref) return { ...m, ref: c.to, wrote: m.ref, heal: 'moved' }
      return c.state === 'linked' ? { ...m, heal: 'kept' } : m
    })
    return { ...rec, marks }
  }
  if (!checking) return rec
  return { ...rec, marks: rec.marks.map(m => (m && m.kind === 'cite' && !m.code ? { ...m, heal: 'checking' } : m)) }
}

/** The glyph after a citation's words: a small spinner while it is checked, a red × when the cited place contradicts it,
 *  a grey ? when the cited place does not exist (its card says why). */
export const HEAL_TAG = { checking: ' ◌', bad: ' ×', gone: ' ?' }
