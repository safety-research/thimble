// place.mjs: where the explainers and the heads-ups stand on the words of a message, and what the observer's look
// gives for them, as a message's part `explain` keeps it (0.10's shell/message.js findTerm, findInLink, readable,
// findRead, stemOf, anchorTerm, placeMarks, glossesOf, headsOf, and the merge in observer/observer.ts). Pure: no `$`.
//
// A term stands where it first stands outside links and code (findTerm), else in a link's words (findInLink, drawn
// inside the link: a citation's words keep its press and take the fill), else in the words as the person reads them
// (findRead: across a link or a code span, each one whole: a mark may cover a citation, which keeps its press). A text shown in place of Claude's words
// (a squeezed version) may say a term in another form, so it is found again there (anchorTerm). The heads-up is placed
// first: its words are often a longer phrase that holds an explainer's term, and the explainer then stands where its
// term is said again.
//
//   linksOf(text)                       -> each markdown link of a text: {start, end, words} (a citation `[w](#)` or any
//                                          other link, outside code)
//   findTerm / findInLink / findRead    -> {start, end} of a term in a text, or null (above)
//   anchorTerm(text, term, taken)       -> {start, end, how} in a text that may say the term in another form
//   placeGlosses(text, part, original)  -> [{id, start, end}] for each item of a part `explain` its text holds
//   glossesOf(list, text, skip)         -> the look's explainers as a part keeps them, those whose term the text holds
//   headsOf(item, text)                 -> the look's heads-up as a part keeps it (one at most), or null
//   mergeLook(msgs, out, memory)        -> what one look adds to each message's part, and the terms it explained
//   markColors(theme)                   -> the explainers' and heads-ups' highlights, a fill per theme, and their frames' keys
//   citeLinks(text)                     -> its links to a file's lines as citations, so the tray draws them as the answer's
//   filePlaces(text)                    -> the file places its links point to
import { codeRanges, marksIn } from '../marks/message.js'

const inside = (ranges, a, b) => ranges.some(([x, y]) => a < y && b > x)
const within = (ranges, a, b) => ranges.some(([x, y]) => a >= x && b <= y)
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const str = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** A term as the observer wrote it, without the backticks of a code span (`hydrate()` is hydrate()). */
export const termOf = term => String(term || '').replace(/`/g, '').trim()

/** Each link of a text, in order, as {start, end, words}: the citations (`[words](#)`, marks/message.js marksIn) and
 *  every other `[words](target)` outside code and outside a citation, its target on one line with no space. */
export function linksOf(text) {
  const s = String(text || '')
  const marks = marksIn(s).map(m => ({ start: m.start, end: m.end, words: m.words }))
  const code = codeRanges(s)
  const taken = marks.map(m => [m.start, m.end])
  const out = [...marks]
  for (const m of s.matchAll(/\[([^\]\n[]+)\]\(([^()\s\n]+|<[^<>\n]+>)\)/g)) {
    const a = m.index
    const b = a + m[0].length
    if (inside(taken, a, b) || within(code, a, b)) continue
    out.push({ start: a, end: b, words: m[1] })
  }
  return out.sort((x, y) => x.start - y.start)
}

/**
 * Where a term first stands: a whole-word match outside links and code, the exact case first. A term may stand as code,
 * whole (`pytest-xdist`) or in part of its words (`AbovePrompt` hook): the match then takes in the code spans it holds,
 * backticks and all.
 */
export function findTerm(text, term, taken = []) {
  const t = termOf(term)
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const code = codeRanges(s)
  const blocked = taken.map(m => [m.start, m.end])
  for (const l of linksOf(s)) blocked.push([l.start, l.end])
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
 * Where a term stands in the words of a link (a citation's words, `[the claimer](#)`), the exact case first: {start,
 * end} inside the link's brackets. Null when no link's words hold it, or only where `taken` already stands.
 */
export function findInLink(text, term, taken = []) {
  const t = termOf(term)
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const blocked = taken.map(m => [m.start, m.end])
  const body = t.split(/\s+/).map(w => '`?' + escapeRe(w) + '`?').join('[`\\s]+')
  for (const flags of ['gu', 'giu']) {
    const re = new RegExp('(?<![\\p{L}\\p{N}_`])' + body + '(?![\\p{L}\\p{N}_`])', flags)
    for (const l of linksOf(s)) {
      const from = l.start + 1
      for (const hit of String(l.words).matchAll(re)) {
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
  const links = linksOf(s)
  const code = codeRanges(s)
  let text = ''
  const at = []
  const add = (ch, i) => { text += ch; at.push(i) }
  const word = c => /[\p{L}\p{N}]/u.test(c || '')
  let i = 0
  while (i < s.length) {
    const l = links.find(m => m.start === i)
    if (l) {
      for (let k = 0; k < l.words.length; k++) if (!/[`*]/.test(l.words[k])) add(l.words[k], i + 1 + k)
      i = l.end
      continue
    }
    const c = code.find(([a]) => a === i)
    if (c) {
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
 * the 13 files in plugin/prompts" is `[5](#) of the 13 files in \`plugin/prompts\``): the term is found in
 * readable(text) and mapped back, with each link and code span it touches whole, so a mark may cover a citation (the
 * citation keeps its press inside it). A mark never stands on another mark, so it takes the longest part of the match
 * outside them. Null when no such part holds a word.
 */
export function findRead(text, term, taken = []) {
  const t = termOf(term)
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const r = readable(s)
  const code = codeRanges(s)
  const blocked = taken.map(m => [m.start, m.end])
  const whole = [...code, ...linksOf(s).map(l => [l.start, l.end])]
  const body = t.split(/\s+/).map(escapeRe).join('\\s+')
  for (const flags of ['gu', 'giu']) {
    const re = new RegExp('(?<![\\p{L}\\p{N}_])' + body + '(?![\\p{L}\\p{N}_])', flags)
    for (const m of r.text.matchAll(re)) {
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
        while (a < b && /[\s,.;:!?()\-–—]/.test(s[a])) a++
        while (b > a && /[\s,.;:!?()\-–—]/.test(s[b - 1])) b--
        for (const [x, y] of whole) if (a < y && b > x) { a = Math.min(a, x); b = Math.max(b, y) }
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

/** A word's stem for matching forms of one word: "claimed", "claiming", "claimer" and "claims" all give "claim". Crude
 *  on purpose: it is used only to find a term again in a rewrite. */
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
  if (/([b-df-hj-km-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1)
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

const WORD = /[\p{L}\p{N}]+/gu

/**
 * Where a term stands in a text that may say it in another form (a rewrite of the message the term came from):
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
  for (const l of linksOf(s)) blocked.push([l.start, l.end])
  const words = [...s.matchAll(WORD)].filter(m => !inside(blocked, m.index, m.index + m[0].length)).map(m => ({ a: m.index, b: m.index + m[0].length, stem: stemOf(m[0]), gap: '' }))
  for (let i = 1; i < words.length; i++) words[i].gap = s.slice(words[i - 1].b, words[i].a)
  const want = (t.match(WORD) || []).map(stemOf)
  if (!want.length) return null
  for (let i = 0; i + want.length <= words.length; i++) {
    let ok = true
    for (let k = 0; k < want.length && ok; k++) ok = words[i + k].stem === want[k] && (k === 0 || /^[\s-]{1,2}$/.test(words[i + k].gap))
    if (ok) return { start: words[i].a, end: words[i + want.length - 1].b, how: 'form' }
  }
  if (want.length < 2) return null
  const own = [...new Set((t.match(WORD) || []).filter(w => w.length >= 4 && !STOP.has(w.toLowerCase())))].sort((x, y) => y.length - x.length)
  for (const w of own) {
    const hit = words.find(x => x.stem === stemOf(w))
    if (hit) return { start: hit.a, end: hit.b, how: 'word' }
  }
  return null
}

/** Whether a text holds a term anywhere a mark can stand. */
export const holds = (text, term) => !!(findTerm(text, term) || findInLink(text, term) || findRead(text, term))

/**
 * Where each item of a part `explain` ({items, order}) stands on a text: [{id, start, end}] in text order, the heads-up
 * first, then the explainers in their order. `original`: the text is shown in place of Claude's words (a squeezed
 * version), so a term is also found in another form (anchorTerm). An item whose term the text does not hold gets no
 * place: the part keeps it, and it stands on its words again when a text that holds them shows.
 */
export function placeGlosses(text, part, original = false) {
  const items = part && typeof part === 'object' && part.items ? part.items : {}
  const order = (Array.isArray(part?.order) ? part.order : Object.keys(items)).filter(id => items[id])
  const sorted = [...order].sort((x, y) => (items[y].kind === 'heads') - (items[x].kind === 'heads'))
  const out = []
  for (const id of sorted) {
    const term = items[id].term
    const at = original ? anchorTerm(text, term, out) : findTerm(text, term, out)
    const place = at ?? findInLink(text, term, out) ?? findRead(text, term, out)
    if (place) out.push({ id, start: place.start, end: place.end })
  }
  return out.sort((a, b) => a.start - b.start)
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

/** The look's explainers as a part keeps them: each a term the text holds, none whose term is in `skip` (the terms
 *  already explained in this conversation), each term once. Ids from `from` + 1 on (g1, g2, ...). */
export function glossesOf(list, text, skip = [], from = 0) {
  const seen = new Set((skip || []).map(norm))
  const out = []
  let n = from
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || typeof g !== 'object') continue
    const term = str(termOf(g.term))
    if (!term || seen.has(norm(term)) || !holds(text, term)) continue
    seen.add(norm(term))
    out.push({ id: `g${++n}`, term, title: str(g.title) || term, body: str(g.body), here: str(g.here) })
  }
  return out
}

/** The look's heads-up as a part keeps it, placed on its term like an explainer (one the text does not hold is dropped,
 *  so it never points at nothing); null when there is none. */
export function headsOf(item, text, id = 'h1') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const term = str(termOf(item.term))
  const bullets = (Array.isArray(item.bullets) ? item.bullets : []).map(b => str(b)).filter(Boolean)
  if (!term || !bullets.length || !holds(text, term)) return null
  return { id, kind: 'heads', term, title: str(item.title) || term, bullets }
}

/**
 * What one look adds (0.10's merge): each explainer in the newest message that holds its term, the heads-up (one at
 * most) in the newest message that holds its words. `msgs`: [{row, text, part}] in order, `text` what the person reads
 * of it (Claude's words and the version shown), `part` its part `explain` now. `memory`: {glossed} (the terms already
 * explained in this conversation). Returns {parts: {row: part}, placed: [term], heads: [title]}.
 */
export function mergeLook(msgs, out, memory) {
  const glossed = Array.isArray(memory?.glossed) ? memory.glossed : []
  const byRow = new Map()
  for (const g of Array.isArray(out?.glosses) ? out.glosses : []) {
    const m = [...msgs].reverse().find(x => glossesOf([g], x.text, glossed).length)
    if (m) byRow.set(m.row, [...(byRow.get(m.row) ?? []), g])
  }
  const headsAt = out?.heads ? [...msgs].reverse().find(x => headsOf(out.heads, x.text)) : undefined
  const parts = {}
  const placed = []
  const heads = []
  for (const m of msgs) {
    if (!byRow.has(m.row) && m !== headsAt) continue
    const cur = m.part && m.part.items ? m.part : { items: {}, order: [] }
    const ids = Object.keys(cur.items)
    const nOf = p => Math.max(0, ...ids.filter(id => id.startsWith(p)).map(id => Number(id.slice(1)) || 0))
    const known = Object.values(cur.items).filter(g => g.kind !== 'heads').map(g => g.term)
    const gs = glossesOf(byRow.get(m.row) ?? [], m.text, [...glossed, ...placed, ...known], nOf('g'))
    const h = m === headsAt ? headsOf(out.heads, m.text, `h${nOf('h') + 1}`) : null
    const add = [...(h ? [h] : []), ...gs]
    if (!add.length) continue
    const next = { items: { ...cur.items }, order: [...cur.order] }
    for (const g of add) { next.items[g.id] = g; next.order.push(g.id) }
    parts[m.row] = next
    placed.push(...gs.map(g => g.term))
    if (h) heads.push(h.title || h.term)
  }
  return { parts, placed, heads }
}

/** The explainers' and heads-ups' colors. Each is a highlight, as a highlighter pen marks words: a fill behind the
 *  words, teal for an explainer (`glossBg`) and orange for a heads-up (`headsBg`), with the words in the theme's own text
 *  color, so they read on it. A background takes no theme key, so each theme has its own shade: light fills under the
 *  light theme's dark text, deep ones under the dark theme's light text. The one the tray shows is bold on a stronger
 *  shade (`glossFocus`, `headsFocus`). A citation is underlined in the text's color, a purple tint on hover
 *  (marks/view.ts citeLook), and a failed citation red with ×, so a highlight never reads as a citation. Inside a
 *  citation's words, which keep the citation's underline, the fill shows behind them in place of the citation's tint.
 *  `gloss` and `heads` are the theme keys of their frames in the tray. */
export function markColors(theme) {
  const fill = theme === 'light'
    ? { glossBg: '#c4eee6', headsBg: '#ffe0b8', glossFocus: '#8edccf', headsFocus: '#ffc98a' }
    : { glossBg: '#1e4d47', headsBg: '#5c3a17', glossFocus: '#2b7068', headsFocus: '#80521f' }
  return { gloss: 'planMode', heads: 'claude', ...fill }
}

/** The file places a text links to (`[words](path#L12-20)`, `[words](path:12)`), as {path, from, to}; no web link, no
 *  citation `(#)`. */
/** A file's place a link points to (`path#L12-20`, `path:12-20` or a path), as {path, from, to}; null for a citation
 *  `#`, a web address or an anchor. */
function placeOf(target) {
  if (target === '#' || /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('#')) return null
  const hit = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(target) || /^(.*?):(\d+)(?:-(\d+))?$/.exec(target)
  return hit ? { path: hit[1], from: Number(hit[2]), to: Number(hit[3] || hit[2]) } : { path: target.replace(/#.*$/, ''), from: null, to: null }
}

/**
 * An explainer's or a heads-up's words with each link to a file's lines made a citation (`[words](#)`), so they draw
 * as the answer's citations do: {text, places}, where places[k] is the file place of the text's k-th citation
 * (marks/message.js marksIn), or null for one that was a citation already. Links inside code stay as they are.
 */
export function citeLinks(text) {
  const s = String(text || '')
  const code = codeRanges(s)
  let out = ''
  let at = 0
  const starts = new Map()
  for (const m of s.matchAll(/\[([^\]\n]+)\]\(<?([^()\s<>\n]+)>?\)/g)) {
    const p = placeOf(m[2])
    if (!p || inside(code, m.index, m.index + m[0].length)) continue
    out += s.slice(at, m.index)
    starts.set(out.length, p)
    out += `[${m[1]}](#)`
    at = m.index + m[0].length
  }
  out += s.slice(at)
  return { text: out, places: marksIn(out).map(k => starts.get(k.start) ?? null) }
}

export function filePlaces(text) {
  const out = []
  for (const m of String(text || '').matchAll(/\[[^\]\n]+\]\(<?([^()\s<>\n]+)>?\)/g)) {
    const p = placeOf(m[1])
    if (p) out.push(p)
  }
  return out
}
