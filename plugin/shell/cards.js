// cards.js: the tray's cards, each an object the drawing contract draws (program + data), so the terminal and the
// browser draw the same card. No `$`, no Node, no DOM: the shell gathers what a card reads through the kernel (`thimble
// resolve --json`, the query's record, the object's file, the lines of a code file) and hands it in.
//
//   cardKind(ref)                                   -> 'query' | 'series' | 'code' | 'rows' | 'object'
//   sourceCard({ref, label, resolved, query, object, lines, path, room})
//       -> {title, right, parts: [{program, data}], sections: [{id, key, words, parts}], mark?, links}
//       a citation's card. One rule for every citation: its parts are the most readable form of what the citation
//       points to, and what reads less easily stays one key away in the same panel, in `sections`:
//         a quote or lines of a file   the cited span with a few rows around it, the quoted words marked; the record
//                                      as the file holds it behind c (raw)
//         a number from a query        the query's output as a table, the cited row and cell marked, with how many
//                                      rows stand behind that cell (a single value: the value and what it counts);
//                                      the query's code behind c, colored as code is (keywords, strings, numbers,
//                                      comments); the rows behind the cell as words behind r only with `rows: true`
//         a series (a sparkline)       its values as a small table, or a plot when they are many; c as above
//         a value of a card            the card itself, the part that holds the value marked (`mark`: the refs that
//                                      part carries); c as above
//   citeCard({ref, label, root, room}, io)          -> the source card of a citation, its inputs read through `io`:
//       {resolve(ref, n, label) -> thimble resolve's JSON, read(path) -> text}. Both surfaces use it (the terminal with
//       its own reads, the page server with Node's), so a citation's card is the same everywhere
//   drawnCard(spec, draw)                           -> the card as a tray wants it: {title, right, drawings, sections:
//       [{id, key, words, drawings}], mark, links, why, problem}, each part drawn by `draw(part)` (a host's sandbox)
//   explainerCard({gloss})                          -> {title, right, parts, links}
//       a gloss's card: what the term is, its picture when the observer drew one, where it mattered here; a gloss of
//       kind 'heads' (an important detail) is a heads-up: its title, its bullets and what to do
//   linksIn(markdown)                               -> the kernel refs a card's words cite, each a nested mark
// A card is drawn part by part (`parts`, each a program and its data), a blank row between parts.
// `links` are the nested marks a card holds, in reading order: [{id, ref, label}]. They look as a citation looks in the
// answer (the cite tone, underlined), with no digit of their own: 2 opens the first, 3 the next, and a click opens any.
import { citeRef } from './object.js'
import { linkSpans, mapLinks, plainWords, seriesRef } from './message.js'

const MAX_LINKS = 8
// a citation's words that name nothing (a pronoun, an arrow): the place it opens is shown in their stead
const VAGUE = /^(here|there|this|that|it|link|source|see|see here|see this|this line|these lines|this file|↗|→|\W*)$/i

/** A citation's words as shown: its own words, or, when they name nothing, the place it opens (`path:12`). */
export function citeWords(words, ref) {
  const w = plainWords(words).trim()
  return VAGUE.test(w) ? placeOf(ref) : w
}
const CODE = /\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|sh|bash|zsh|sql|r|jl|scala|swift|cs|lua|pl|toml|ya?ml|ini|cfg|conf|md|rst|txt|log|html|css|scss|vue|svelte|tf|dockerfile)$/i

/** The keys of a citation card's sections, the same for every card: r the rows behind a value, c its code (or, for a
 *  record, the record as the file holds it). */
export const SECTION_KEYS = { rows: 'r', code: 'c', raw: 'c' }

/** Which card a ref gets. */
export function cardKind(ref) {
  const r = String(ref || '')
  if (seriesRef(r)) return 'series'
  if (/^[qr]\d+(?:#|$)/.test(r)) return 'query'
  if (r.startsWith('obj:')) return 'object'
  const path = r.split('#')[0]
  if (CODE.test(path) && /#L\d+(?:-L?\d+)?$/.test(r)) return 'code'
  return 'rows'
}

/** The kernel refs a card's words cite (`[words](ref)`), each once, as nested marks. */
export function linksIn(md, look = null) {
  const out = []
  for (const m of linkSpans(md)) {
    const c = look ? look(m[1], m[2]) : null
    // a citation the healing pass unwrapped is words, not a link; one it re-pointed opens its new place
    if (c && c.state === 'quiet') continue
    const ref = c && c.to && c.state === 'linked' ? c.to : citeRef(m[2])
    if (!ref || out.some(x => x.ref === ref)) continue
    out.push({ id: `n${out.length + 1}`, ref, label: citeWords(m[1], ref), ...(c && c.to && c.to !== c.ref && c.state === 'linked' && c.how !== 'folder' ? { wrote: c.ref } : {}) })
  }
  return out.slice(0, MAX_LINKS)
}

// ---- the healing pass on a card's words (an explainer, a takeaway): the kernel's `thimble heal` reads the words with
// each citation's target as the ref the card opens, and a lookup gives what it did to each citation

/** Card words as the healing pass reads them: each citation's target written as the ref the card opens. */
export function healMd(md) {
  return mapLinks(md || '', (all, w, t) => { const r = citeRef(t); return r ? `[${w}](${r})` : all })
}

/** What the pass did to a citation of card words, by its words and target (by its ref alone when the words were
 *  rewritten for the drawing): a change `{state, to, why}`, or null. */
export function healLook(heal) {
  const by = new Map()
  const byRef = new Map()
  for (const c of (heal && Array.isArray(heal.changes) ? heal.changes : [])) {
    if (!c) continue
    if (!by.has(`${c.label}|${c.ref}`)) by.set(`${c.label}|${c.ref}`, c)
    if (!byRef.has(c.ref)) byRef.set(c.ref, c)
  }
  if (!by.size) return null
  return (words, target) => { const r = citeRef(target) || String(target || '').trim(); return by.get(`${words}|${r}`) || byRef.get(r) || null }
}

/** Card words with each nested mark as a toolkit link to its cite in the cite tone (`{cite:[words](#n1)}`), as a
 *  citation in the answer looks, other markup escaped. */
export function linkedText(md, links, look = null) {
  const esc = s => String(s).replace(/`([^`\n]+)`/g, '$1').replace(/[\\{}[\]*]/g, c => '\\' + c)
  let out = ''
  let i = 0
  const s = String(md || '')
  for (const m of linkSpans(s)) {
    out += esc(s.slice(i, m.index)).replace(/\\\*\\\*([^*]+?)\\\*\\\*/g, '**$1**')
    // the healing pass: an unwrapped citation in grey, a contradicted one with a red ×, a re-pointed one at its new place
    const c = look ? look(m[1], m[2]) : null
    const ref = c && c.to && c.state === 'linked' ? c.to : citeRef(m[2])
    const k = c && c.state === 'quiet' ? -1 : links.findIndex(x => x.ref === ref)
    out += c && c.state === 'quiet' ? `{dim:${esc(m[1])}}${c.how === 'gone' ? '{dim: ?}' : ''}` : k >= 0 ? `{cite:[${esc(citeWords(m[1], links[k].ref))}](#${links[k].id})}${c && c.state === 'contradicted' ? '{bad: ×}' : ''}` : esc(m[1])
    i = m.index + m[0].length
  }
  return out + esc(s.slice(i)).replace(/\\\*\\\*([^*]+?)\\\*\\\*/g, '**$1**')
}

// a number as words: a whole one with its thousands, one of 1 or more with at most two decimals, a smaller one with two
// significant digits, so 0.0037 never reads as 0
const fmtN = v => (typeof v !== 'number' ? String(v ?? '')
  : v.toLocaleString('en-US', Number.isInteger(v) || Math.abs(v) >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 2 }))

/** The numbers a citation's words write, each with its decimals and whether it is a percent: `5.5%` is
 *  {x: 5.5, d: 1, pct: true}, `1,268 files` {x: 1268, d: 0, pct: false}. */
export function writtenNumbers(words) {
  const out = []
  for (const m of String(words ?? '').matchAll(/(?<![\w.])(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?(\s?%|\s?percent\b)?/g)) {
    out.push({ x: Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`), d: m[2] ? m[2].length : 0, pct: !!m[3] })
  }
  return out
}

/** How the reply wrote a cited value, so its card shows it the same way: {scale, d, pct} when the citation's words write
 *  a number the value rounds to (within one unit of its last written digit), a share as a percent when they write a
 *  percent (`0.4%` for 0.0037: scale 100); null when they write none. */
export function citedForm(v, words) {
  if (typeof v !== 'number' || !isFinite(v)) return null
  const near = (x, w) => Math.abs(x - w.x) <= 10 ** -w.d * 1.0001
  for (const w of writtenNumbers(words)) {
    if (w.pct && Math.abs(v) <= 1.5 && near(v * 100, w)) return { scale: 100, d: w.d, pct: true }
    if (near(v, w)) return { scale: 1, d: w.d, pct: w.pct }
  }
  return null
}

/** A number in a cited form (citedForm): at least the decimals the reply wrote and two significant digits, so 0.0037
 *  written as `0.4%` shows 0.37%, and 0.055 written as `5.5%` shows 5.5%. */
export function inForm(v, f) {
  if (typeof v !== 'number' || !isFinite(v)) return fmtN(v)
  const x = v * f.scale
  const sig = x === 0 ? 0 : Math.max(0, 1 - Math.floor(Math.log10(Math.abs(x))))
  return `${x.toLocaleString('en-US', { minimumFractionDigits: f.d, maximumFractionDigits: Math.min(8, Math.max(f.d, sig)) })}${f.pct ? '%' : ''}`
}

/** Values cut to `n` characters so that values that differ still differ: at the end when that keeps them apart, else in
 *  the middle, their start and end kept (`AgentMass…LinkHelper771` and `AgentMass…AgentRelent`). Self-contained: the
 *  query card's program holds its source, to cut a column to the room the card has. */
export function distinctCut(vals, n) {
  const w = Math.max(3, n)
  const apart = list => new Set(list).size === new Set(vals).size
  const end = vals.map(s => (s.length <= w ? s : s.slice(0, w - 1) + '…'))
  if (apart(end)) return end
  const head = Math.max(1, Math.floor((w - 1) * 0.4))
  const tail = w - 1 - head
  return vals.map(s => (s.length <= w ? s : s.slice(0, head) + '…' + s.slice(s.length - tail)))
}
const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…' }
/** Words safe to put in the toolkit's markup. */
const esc = s => String(s ?? '').replace(/[\\{}[\]*]/g, c => '\\' + c)
const plural = (n, one, many = `${one}s`) => `${fmtN(n)} ${n === 1 ? one : many}`

/** The files a resolve names, in a few words. */
function filesOf(resolved, query) {
  const fromRows = [...new Set((resolved?.rows || []).map(x => String(x).split('#')[0]))]
  const fromQuery = (query?.inputs || []).map(x => x.path)
  const files = fromRows.length ? fromRows : fromQuery
  if (!files.length) return ''
  return files.length === 1 ? files[0] : `${files.length} files`
}

/** The query's output column, the cited row and its key's words, read from the query's record. */
function columnOf(query, ref) {
  const table = Array.isArray(query?.table) ? query.table : []
  const m = /^[qr]\d+(?:#(.*?))?(?:@([^@]+))?$/.exec(String(ref))
  const frag = m?.[1] || ''
  const keys = Array.isArray(query?.keys) ? query.keys : []
  let col = m?.[2] || null
  let hot = -1
  if (/^row=(\d+)$/.test(frag)) hot = Number(frag.slice(4)) - 1
  else if (frag && frag.includes('=')) {
    const want = Object.fromEntries(frag.split('&').map(p => { const j = p.indexOf('='); return [decodeURIComponent(p.slice(0, j)), decodeURIComponent(p.slice(j + 1))] }))
    // a key value as written, else by its slug (the kernel writes "won (clean ep)" as won-clean-ep)
    const slug = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const colOf = (r, k) => (k in r ? k : Object.keys(r).find(c => slug(c) === slug(k)))
    hot = table.findIndex(r => Object.entries(want).every(([k, v]) => String(r[colOf(r, k)]) === v))
    if (hot < 0) hot = table.findIndex(r => Object.entries(want).every(([k, v]) => { const c = colOf(r, k); return c != null && slug(v) && slug(r[c]) === slug(v) }))
  } else if (frag && !col) col = frag
  const cols = table.length ? Object.keys(table[0]).filter(k => !k.startsWith('_')) : []
  if (col && !cols.includes(col)) col = cols.find(c => c.toLowerCase().replace(/[^a-z0-9]+/g, '-') === col.toLowerCase().replace(/[^a-z0-9]+/g, '-')) || col
  if (!col) col = cols.find(c => typeof table[0]?.[c] === 'number' && !keys.includes(c)) || cols[cols.length - 1] || null
  // the words a row is named by: its key columns, unless the key is only a row number (a frame's index), then its
  // first column of words
  const named = keys.filter(k => cols.includes(k) && k !== 'index' && !(table.length && table.every(r => Number.isInteger(r[k])) && k.endsWith('index')))
  const words = cols.filter(c => c !== col && table.some(r => typeof r[c] === 'string'))
  const keyCols = named.length ? named : words.length ? words.slice(0, 1) : cols.filter(c => c !== col).slice(0, 1)
  const labelOf = r => keyCols.map(k => (r[k] === '' || r[k] == null ? '(none)' : String(r[k]))).join(' · ') || ''
  return { table, cols, col, hot, keyCols, labelOf }
}

// ------------------------------------------------------------------------------------------------ programs

// the cited span of a file: its rows around the cited ones, each with its number; a cited row in full (its quoted words
// marked), the others one line each, stepped back
const SPAN_PROGRAM = `
const nw = Math.max(1, ...data.rows.map(r => k.len(r.n)))
const parts = []
for (const r of data.rows) {
  const gutter = k.text((r.hot ? '{accent:' : '{dim:') + k.escape(r.n.padStart(nw)) + '}' + (r.hot ? ' {accent:▌}' : '  '), { w: nw + 2, wrap: false })
  const body = r.hot
    ? k.stack(k.text(r.text || ' ', { max: data.hotMax }), r.meta ? k.text('{dim:' + k.escape(r.meta) + '}', { max: 2 }) : false)
    : k.text((data.plain ? (r.text || ' ') : '{dim:' + (r.text || ' ') + '}') + (r.meta ? '  {dim:' + k.escape(r.meta) + '}' : ''), { wrap: false })
  parts.push(k.beside(gutter, body, { gap: 1 }))
}
if (data.more) parts.push(k.text('{dim:' + k.escape(data.more) + '}', { wrap: false }))
return k.stack(parts)`

// a query's output as a table: the cited row marked in the gutter, its cell lit; how many rows stand behind that cell
const QUERY_PROGRAM = `
const parts = []
if (data.about) parts.push(k.text(data.about, { wrap: false }))
// a column of words wider than the room is cut so that its rows still differ (distinctCut), the widest first
${distinctCut.toString()}
const nat = data.cols.map((c, i) => Math.max(k.len(c.label), ...data.rows.map(r => k.len(r.cells[i]))))
const wd = nat.slice()
const room = k.w - 1 - 2 * data.cols.length
for (let guard = 0; guard < 400 && wd.reduce((s, x) => s + x, 0) > room; guard++) {
  let j = -1
  wd.forEach((x, i) => { if (data.cols[i].align !== 'right' && x > 8 && (j < 0 || x > wd[j])) j = i })
  if (j < 0) break
  wd[j]--
}
const cells = data.rows.map(r => r.cells.slice())
wd.forEach((w, i) => { if (w < nat[i]) distinctCut(cells.map(c => c[i]), w).forEach((s, j) => { cells[j][i] = s }) })
const cols = [{ key: 0, label: '' }].concat(data.cols.map((c, i) => ({ key: i + 1, label: c.label, align: c.align })))
const rows = data.rows.map((r, ri) => [r.hot ? { text: '▌', tone: 'accent' } : ' '].concat(cells[ri].map((s, i) =>
  ({ text: s, tone: r.hot && i === data.hotCol ? 'accent' : r.hot || i === data.hotCol ? 'ink' : 'dim', bold: !!r.hot }))))
parts.push(k.table(rows, { cols, raw: true }))
if (data.more) parts.push(k.text('{dim:' + k.escape(data.more) + '}', { wrap: false }))
if (data.behind) parts.push(k.text(data.behind, { wrap: false }))
return k.stack(parts)`

// a query whose output is one value: the value, what it counts, and how many rows stand behind it
const VALUE_PROGRAM = `
return k.stack(
  k.text('**' + k.escape(data.value) + '**', { wrap: false }),
  k.text(data.what, { max: 2 }),
  data.behind ? k.text(data.behind, { wrap: false }) : false)`

// a series: a small table of bars when it is short, else a plot, its values counted in the line above it
const SERIES_PROGRAM = `
const parts = []
const short = data.rows.length <= data.room
if (data.about || !short) parts.push(k.text(data.about + (short ? '' : (data.about ? ' ' : '') + '{dim:· ' + k.escape(data.first) + '}'), { wrap: false }))
if (short) {
  parts.push(k.bars(data.rows.map(r => ({ label: r.label, value: r.value, tone: 'accent' })), { labelW: Math.min(data.labelW, Math.floor(k.w * 0.4)) }))
} else {
  const n = data.rows.length
  const ticks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => ({ at: i, label: data.rows[i].label }))
  parts.push(k.plot([{ name: data.col, values: data.rows.map(r => r.value) }], { h: Math.max(3, data.room), legend: false, x: { ticks } }))
}
if (data.behind) parts.push(k.text(data.behind, { wrap: false }))
return k.stack(parts)`

// records as a person reads them: each its words and who and when, never its field: value pairs
const RECORDS_PROGRAM = `
const parts = []
if (data.head) parts.push(k.text(data.head, { wrap: false }))
// the record's place keeps its line or row whole: a long one loses the start of its path, and the column never shrinks
const cap = Math.max(10, Math.min(24, Math.floor(k.w / 3)))
const place = s => (k.len(s) > cap ? '…' + s.slice(s.length - cap + 1) : s)
const w = Math.max(4, ...data.recs.map(r => k.len(place(r.ref))))
for (const r of data.recs) parts.push(k.beside(
  k.text((r.hot ? '{accent:' : '{dim:') + k.escape(place(r.ref)) + '}', { w, minW: w, wrap: false }),
  k.text(k.escape(r.text) + (r.meta ? '  {dim:' + k.escape(r.meta) + '}' : ''), { max: data.max, bold: !!r.hot }),
  { gap: 2 }))
if (!data.recs.length) parts.push(k.text('{dim:' + k.escape(data.empty) + '}'))
if (data.more) parts.push(k.text(data.more, { wrap: false }))
return k.stack(parts)`

// code with its line numbers, each line already colored as markup (codeMarkup)
const CODE_PROGRAM = `
const parts = []
if (data.head) parts.push(k.text(data.head, { wrap: false }))
const from = data.from || 0
if (data.above) parts.push(k.text('{dim:' + k.escape(data.above) + '}', { wrap: false }))
const nw = String(data.code.length + from).length
data.code.forEach((l, i) => parts.push(k.beside(k.text('{dim:' + String(i + 1 + from).padStart(nw) + '}', { w: nw, wrap: false }), k.text(l || ' ', { wrap: false }), { gap: 2 })))
if (data.more) parts.push(k.text('{dim:' + k.escape(data.more) + '}', { wrap: false }))
return k.stack(parts)`

// what a query printed: a few of its lines, those that hold a cited value marked in the gutter, the value lit
const OUTPUT_PROGRAM = `
const parts = []
if (data.head) parts.push(k.text(data.head, { wrap: false }))
for (const l of data.lines) {
  if (l.gap) parts.push(k.text('{dim:' + k.escape(l.gap) + '}', { wrap: false }))
  else parts.push(k.beside(k.text(l.hot ? '{accent:▌}' : ' ', { w: 1 }), k.text(l.text || ' ', { wrap: false }), { gap: 1 }))
}
if (data.more) parts.push(k.text('{dim:' + k.escape(data.more) + '}', { wrap: false }))
return k.stack(parts)`

// a record as the file holds it, the field the citation quotes marked
const RAW_PROGRAM = `
const parts = [k.text('{dim:' + k.escape(data.head) + '}', { wrap: false })]
for (const l of data.lines) {
  if (l.gap) parts.push(k.text('{dim:' + k.escape(l.gap) + '}', { wrap: false }))
  else parts.push(k.beside(k.text(l.hot ? '{accent:▌}' : ' ', { w: 1 }), k.text(l.text || ' ', { raw: true, wrap: false, bold: !!l.hot }), { gap: 0 }))
}
return k.stack(parts)`

// a few lines of words
const LINES_PROGRAM = `
return k.stack(data.lines.map(l => k.text(l, { max: 2 })))`

const WORDS_PROGRAM = `
for (const l of data.links) k.cite(l.id, { text: l.label, ref: l.ref })
return k.text(data.text)`

// ------------------------------------------------------------------------------------------------ cards

/** A span's text as markup: the quoted words (`at`) lit, the rest as written. */
function spanText(r) {
  const t = String(r.text ?? '')
  const field = r.field ? `{dim:${esc(r.field.replace(/^.*\./, ''))}:} ` : ''
  // a tab drawn as four spaces, as the rows around it are
  const out = s => esc(s.replace(/\t/g, '    '))
  if (!Array.isArray(r.at) || !r.hot) return field + out(t)
  const [a, b] = r.at
  return `${field}${out(t.slice(0, a))}{accent:**${out(t.slice(a, b))}**}${out(t.slice(b))}`
}

/** The line, row or value a ref names in a few words: `revisions.jsonl:41`, `runs.csv row 3`, `forge.db prs/12`. */
export function placeOf(ref) {
  const [path, frag = ''] = String(ref || '').split(/#(.*)/s)
  const m = /^L(\d+)(?:-L?(\d+))?(?:\.b\d+)?$/.exec(frag)
  if (m) return `${path}:${m[1]}${m[2] && m[2] !== m[1] ? `-${m[2]}` : ''}`
  return frag ? `${path} ${frag.replace(/^row=/, 'row ')}` : path
}

/** A link to the file a source ref names, as Claude Code links a file in a reply (`[words](path#L41)`): the file's
 *  absolute path as a `file:` URL, the line kept as its fragment. Null for a ref that names no file (a query, an
 *  object's value) or no root to place it in. */
export function fileLink(ref, root) {
  const r = String(ref || '')
  if (!r || /^([qr]\d+(?:[#@]|$)|obj:)/.test(r) || /^[a-z][a-z0-9+.-]*:\/\//i.test(r)) return null
  const [path, frag = ''] = r.split(/#(.*)/s)
  if (!path || (!path.startsWith('/') && !root)) return null
  const abs = path.startsWith('/') ? path : `${String(root).replace(/\/+$/, '')}/${path}`
  const line = /^L(\d+)/.exec(frag)
  const href = `file://${encodeURI(abs).replace(/#/g, '%23').replace(/\?/g, '%3F')}${line ? `#L${line[1]}` : ''}`
  return { href, label: placeOf(r), path: abs }
}

// terminals Claude Code takes to draw an OSC 8 hyperlink by their name, as it names them (2.1.301)
const LINK_TERMS = ['ghostty', 'Hyper', 'kitty', 'alacritty', 'iTerm.app', 'iTerm2', 'WarpTerminal']
const version = v => String(v || '').split('.').map(x => parseInt(x, 10) || 0)

/**
 * Whether Claude Code draws a link of a reply as an OSC 8 hyperlink in this terminal, by the test it applies to the
 * environment (`env`: the variables it reads). Where it does not, it draws the link's words, then the address in
 * brackets. Only the cases where it surely draws one say yes, so a surface that asks never shows that address:
 * FORCE_HYPERLINK, a terminal known by its name (TERM_PROGRAM, LC_TERMINAL, TERM), tmux 3.4 or later (which passes a
 * hyperlink on where its `terminal-features` give the outer terminal `hyperlinks`), Windows Terminal outside tmux, and
 * VTE 0.50.1 or later.
 */
export function drawsHyperlinks(env = {}) {
  const e = env || {}
  if (typeof e.FORCE_HYPERLINK === 'string' && e.FORCE_HYPERLINK) return parseInt(e.FORCE_HYPERLINK, 10) !== 0
  if (typeof e.FORCE_HYPERLINK === 'string') return false
  const p = e.TERM_PROGRAM || ''
  if (LINK_TERMS.includes(p) || LINK_TERMS.includes(e.LC_TERMINAL || '')) return true
  if (e.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return true
  if (e.WT_SESSION && p !== 'tmux' && !e.TMUX) return true
  if (p === 'tmux') { const [a, b] = version(e.TERM_PROGRAM_VERSION); return a > 3 || (a === 3 && b >= 4) }
  if (String(e.TERM || '').includes('kitty')) return true
  if (e.CI || e.TEAMCITY_VERSION) return false
  if (p === 'WezTerm') return version(e.TERM_PROGRAM_VERSION)[0] >= 20200620
  if (p === 'vscode') { const [a, b] = version(e.TERM_PROGRAM_VERSION); return a > 1 || (a === 1 && b >= 72) }
  if (e.VTE_VERSION && e.VTE_VERSION !== '0.50.0') {
    const v = /^\d{3,4}$/.test(e.VTE_VERSION) ? [0, parseInt(e.VTE_VERSION.slice(0, -2), 10), 0] : version(e.VTE_VERSION)
    return v[0] > 0 || v[1] >= 50
  }
  return e.TERM === 'alacritty'
}

/** A row around the cited ones, on one line: its own spaces kept (a code line's indent), a tab as four spaces, a break
 *  inside it as one space, and at most n characters. */
const rowLine = (s, n) => { const t = String(s ?? '').replace(/\t/g, '    ').replace(/\s*[\r\n]+\s*/g, ' ').trimEnd(); return t.length <= n ? t : t.slice(0, n - 1) + '…' }

/** The span part of a source citation: the kernel's span (resolve's `span`), or the code file's lines read here. */
function spanPart(sp, room) {
  const rows = (sp.rows || []).map(r => ({ ...r, n: r.n != null ? String(r.n) : '', text: r.hot ? spanText(r) : esc(rowLine(r.text, 300)) }))
  const hot = rows.filter(r => r.hot).length || 1
  const metas = rows.filter(r => r.hot && r.meta).length
  const hotMax = Math.max(1, Math.min(8, Math.floor((room - (rows.length - hot) - metas) / hot)))
  const more = sp.cited > hot ? `showing ${hot} of the ${fmtN(sp.cited)} ${sp.unit || 'row'}s it cites` : ''
  return { program: SPAN_PROGRAM, data: { rows, hotMax, more } }
}

/** What the files behind a value call their entries, as the kernel says it (resolve's `unit`, the one mapping that
 *  coverage counts by): records of JSON and JSONL, rows of a table, lines of text, `entries` when no kind holds most of
 *  them. null for files with no entries (an image, a PDF), which have no rows section. */
export function entryWords(r) {
  if (r && r.unit === null) return null
  if (r && typeof r.unit === 'string') return { many: r.unit, one: r.unit_one || r.unit }
  return { many: 'rows', one: 'row' }
}

// a query's code colored as code is, in the kit's tones: keywords, strings, numbers, and comments dim
const KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '))
const CODE_TOKEN = /(#.*$)|([rRbBfFuU]{0,2}(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?))|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)/g
/** One line of a query's code as markup: each keyword, string, number and comment in its tone, the rest as written. */
export function codeMarkup(line) {
  const t = String(line ?? '')
  let out = ''
  let at = 0
  for (const m of t.matchAll(CODE_TOKEN)) {
    const [w, comment, str, num, word] = m
    const tone = comment ? 'dim' : str ? 'c6' : num ? 'c3' : word && KEYWORDS.has(word) ? 'c2' : null
    out += esc(t.slice(at, m.index)) + (tone ? `{${tone}:${esc(w)}}` : esc(w))
    at = m.index + w.length
  }
  return out + esc(t.slice(at))
}

/** The line under a query's code the first time a session's trays show one that calls thimble's own load or tally. */
export const HELPERS_NOTE = "load reads a file's rows; tally counts them by group"
const HELPERS = /\b(?:load|tally)\s*\(/

/** Whether a value has a rows section: entries stand behind it. */
const hasRows = r => r.count > 0 && entryWords(r) !== null

/** The rows section: the entries behind a value as a person reads them, a few spread across them, named in the files'
 *  own word (`347 records of revisions.jsonl behind it`, `r records`). */
function rowsSection(r, what, room) {
  const w = entryWords(r) || { many: 'rows', one: 'row' }
  const recs = (r.records || []).map(x => ({ ref: String(x.ref).replace(/^.*\//, ''), text: short(String(x.words || x.text || ''), 400), meta: short(String(x.meta || ''), 60) }))
  const total = r.count != null ? r.count : recs.length
  const files = filesOf(r, null)
  const head = r.count != null
    ? `**${fmtN(total)}** ${total === 1 ? w.one : w.many} ${files ? `of ${esc(files)} ` : ''}behind ${esc(what)}${recs.length < total ? ` {dim:· ${recs.length} spread across them}` : ''}`
    : `{dim:behind ${esc(what)}:} ${esc(files ? `all of ${files}` : `no ${w.many}`)}`
  const max = Math.max(1, Math.min(3, Math.floor((room - 1) / Math.max(1, recs.length))))
  return { id: 'rows', key: SECTION_KEYS.rows, words: w.many, parts: [{ program: RECORDS_PROGRAM, data: { head, recs, max, empty: r.why || `no ${w.many} stand behind it`, more: '' } }] }
}

/** A printed line as markup: the spans that hold a cited value (`at`, [[start, end]]) lit, the rest as printed. */
function outLine(text, at) {
  const t = String(text ?? '').replace(/\t/g, '    ')
  let out = ''
  let i = 0
  for (const [a, b] of (Array.isArray(at) ? at : []).filter(x => Array.isArray(x) && x[0] >= i).sort((x, y) => x[0] - y[0])) {
    out += esc(t.slice(i, a)) + `{accent:**${esc(t.slice(a, b))}**}`
    i = b
  }
  return out + esc(t.slice(i))
}

/** The output part of a query: its printed lines from the top, `fit` of them, those that hold a cited value (resolve's
 *  `shown.lines`) marked and always in view (the lines before them cut, a gap saying how many). */
export function outputPart(query, shown, fit, head = '') {
  const all = String(query?.stdout || '').replace(/\n+$/, '').split('\n')
  if (!String(query?.stdout || '').trim()) return null
  const hot = new Map((shown?.lines || []).map(l => [l.n, l.at]))
  const line = n => ({ text: outLine(all[n - 1].slice(0, 300), hot.get(n)), hot: hot.has(n) })
  const want = Math.max(2, fit)
  const nums = all.map((_, j) => j + 1)
  const marked = nums.filter(n => hot.has(n))
  let pick = nums.slice(0, want)
  // a marked line past the room: the first lines, a gap, the marked lines (each with the line after it while room is left)
  if (marked.length && marked.some(n => !pick.includes(n))) {
    const keep = marked.slice(0, Math.max(1, want - 2))
    const top = nums.slice(0, Math.max(0, want - 1 - keep.length)).filter(n => n < keep[0])
    pick = [...top, ...keep]
  }
  const lines = []
  pick.forEach((n, j) => {
    if (j && n > pick[j - 1] + 1) lines.push({ gap: `… ${plural(n - pick[j - 1] - 1, 'line')}` })
    else if (!j && n > 1) lines.push({ gap: `… ${plural(n - 1, 'line')}` })
    lines.push(line(n))
  })
  const rest = all.length - pick[pick.length - 1]
  return { program: OUTPUT_PROGRAM, data: { head, lines, more: rest > 0 ? `… ${plural(rest, 'more line')}` : '' } }
}

/** The one line a person needs about where a value comes from, when something is wrong with it: a file the query
 *  read changed since it ran. The kernel's other notes are about how it found rows, and say nothing to a person. */
function staleLine(r, q) {
  const stale = (q && Array.isArray(q.stale) && q.stale) || ((r.chain || []).find(c => c.step === 'query') || {}).stale
  return Array.isArray(stale) && stale.length ? `{dim:${esc(stale.join(', '))} changed since ${esc(q?.id || 'the query')} ran, so this output may be out of date}` : ''
}

/** The code section: the query that made the value, its lines numbered and colored as code is, then what it printed
 *  and the head of its result, the cited value marked there; then the card or the binding it comes through. The files
 *  it reads are in the code itself, so no line repeats them.
 *  `note`: the line the tray adds under the code the first time a session shows a query that calls load or tally. */
function codeSection(r, query, ref, room) {
  const q = query || (r.chain || []).find(c => c.step === 'query') || null
  const code = String(q?.code || '').replace(/\t/g, '    ').replace(/\n+$/, '').split('\n')
  const outN = q?.stdout ? String(q.stdout).replace(/\n+$/, '').split('\n').length : 0
  // the rows the section takes: its head, the code, the line saying it was cut, the note under it, a blank row, the
  // output's head, its lines and the line saying how many more, within the band's rows (`room` less two, as the band
  // stands in Claude Code with its bar under it)
  const outFit = outN ? Math.min(outN, Math.max(3, Math.floor((room - 7) / 2))) : 0
  const cut = Math.max(3, outFit ? room - 8 - outFit : room - 5)
  // one line past the room shows whole: the line saying it was cut would take its row
  const fit = code.length === cut + 1 ? code.length : cut
  const lines = []
  const chain = (r.chain || []).filter(c => c.step === 'object' || c.step === 'binding')
  for (const c of chain) {
    if (c.step === 'object') lines.push(`{dim:card} ${esc(c.title || c.id)}${c.at ? ` {dim:at} ${esc(c.at)}` : ''}`)
    else if (c.step === 'binding') lines.push(`{dim:bound from} ${esc(c.from)}`)
  }
  const stale = staleLine(r, q)
  if (stale) lines.push(stale)
  const head = q ? `{dim:${esc(q.id || '')} ·} ${esc(q.about || 'the query')}` : `{dim:no query made this value}`
  // a value it printed: the code up to its last print, so the line that printed the value is in view
  let from = 0
  const last = r.shown?.lines?.length ? code.reduce((at, l, j) => (/\bprint\s*\(/.test(l) ? j : at), -1) : -1
  if (last >= fit) from = Math.min(code.length - fit + 1, last + 2 - fit)
  const shown = q?.code ? code.slice(from, from + fit - (from ? 1 : 0)) : []
  const rest = code.length - from - shown.length
  const out = q?.code ? outputPart(q, r.shown, outFit, '{dim:output}') : null
  return {
    id: 'code', key: SECTION_KEYS.code, words: 'code',
    ...(shown.some(l => HELPERS.test(l)) ? { note: HELPERS_NOTE } : {}),
    parts: [
      { program: CODE_PROGRAM, data: { head, from, above: from ? `… ${plural(from, 'line')} above` : '', code: shown.map(codeMarkup), more: rest > 0 ? `… ${plural(rest, 'more line')}` : '' } },
      ...(out ? [out] : []),
      ...(lines.length ? [{ program: LINES_PROGRAM, data: { lines } }] : []),
    ],
  }
}

/** A citation whose values only the query's printed text holds: the end of its code (up to its last print) and the
 *  lines it printed that hold them, the values lit, so the person sees where they came from. */
function printedCard(label, right, query, shown, room) {
  const code = String(query?.code || '').replace(/\t/g, '    ').replace(/\n+$/, '').split('\n')
  const outFit = Math.min(3, shown.lines.length)
  const fit = Math.max(2, room - 4 - outFit)
  let end = code.length
  for (let j = code.length - 1; j >= 0; j--) if (/\bprint\s*\(/.test(code[j])) { end = j + 1; break }
  const start = Math.max(0, end - fit)
  const head = `{dim:${esc(query?.id || '')} ·} ${esc(short(query?.about || 'the query', 80))}`
  const out = outputPart(query, { lines: shown.lines }, outFit, `{dim:${esc(query?.id || 'it')} printed}`)
  // only the marked lines: a printed card shows where the value came from, not the whole output
  out.data.lines = out.data.lines.filter(l => l.hot)
  out.data.more = ''
  return {
    title: label, right, links: [],
    parts: [{ program: CODE_PROGRAM, data: { head, from: start, above: start ? `… ${plural(start, 'line')} above` : '', code: code.slice(start, end).map(codeMarkup), more: '' } }, out],
  }
}

/** The raw section of a cited record: the record as the file holds it, the field its citation quotes marked and always
 *  in view (the lines before it cut to fit). */
function rawSection(sp, room) {
  const all = String(sp.raw || '').split('\n').map(t => ({ text: t.slice(0, 300) }))
  const at = (sp.rows || []).find(r => r.hot)
  const field = at?.field ? String(at.field).split('.')[0] : null
  const hot = field ? all.findIndex(l => l.text.startsWith(` ${JSON.stringify(field)}:`)) : -1
  if (hot >= 0) all[hot].hot = true
  const fit = Math.max(4, room - 2)
  let lines = all.slice(0, fit)
  // the quoted field past the room: the first lines, a gap that says how many, the field, the lines after it that fit
  if (hot >= fit - 1) lines = [...all.slice(0, fit - 4), { gap: `… ${plural(hot - (fit - 4), 'line')}` }, ...all.slice(hot, hot + 3)]
  const shown = lines.filter(l => !l.gap).length + (hot >= fit - 1 ? hot - (fit - 4) : 0)
  const rest = all.length - shown + (sp.raw_more || 0)
  if (rest > 0) lines.push({ gap: `… ${plural(rest, 'more line')}` })
  return { id: 'raw', key: SECTION_KEYS.raw, words: 'raw', parts: [{ program: RAW_PROGRAM, data: { head: `${at ? placeOf(at.ref) : sp.path}, as the file holds it`, lines } }] }
}

/** How many rows stand behind a value, in one line: `6,543 rows behind it · revisions.jsonl`. */
// where a value comes from (its rows, its files, its lineage) is the code section's, one key away: a card's own words
// carry none of it
function behindLine() {
  return ''
}

/** A cell as the table shows it. */
// words are cut to the room the card has when it is drawn (QUERY_PROGRAM), not here, so rows that differ stay apart
const cellText = v => short(typeof v === 'number' ? fmtN(v) : v == null || v === '' ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v), 120)

/**
 * A citation's card. `resolved` is `thimble resolve <ref> --json`; `query` the query's record (thimble/queries/r<n>.json)
 * for a query ref; `object` the object's record for a value of a card; `lines` the file's lines around the cited ones
 * for a code ref the kernel gave no span for ({n, text}); `room` the card's rows; `rows` adds the rows behind a value as a
 * section (r), which no surface shows now: the code says what the value reads.
 */
export function sourceCard({ ref: wrote, label, resolved, query, object, lines, path, room = 9, rows: withRows = false }) {
  const r = resolved || {}
  // a citation of a whole query that the kernel narrowed to the row holding its value: the card is about that row
  const ref = typeof r.narrowed === 'string' && r.narrowed ? r.narrowed : wrote
  const kind = cardKind(ref)
  const files = filesOf(r, query)
  const right = `cite · ${short(files || ref, 40)}`
  const deep = Math.max(room + 6, 14)
  if (r.error && kind !== 'code') {
    // a place that is gone (a query deleted, a file moved): the frame names the ref, the card says what is missing
    // (`no query r21`), as the healing pass says it of a place gone when it checked (tray.js cardBody)
    const e = String(r.error).trim()
    const gone = [wrote, ref].reduce((s, x) => (s.startsWith(`${x}: `) ? s.slice(x.length + 2) : s), e)
    return { title: label, right, parts: [], sections: [], links: [], unresolved: true, gone: short(gone, 200) }
  }
  const about = query?.about ? esc(short(query.about, 80)) : ''
  if (kind === 'query' || kind === 'series') {
    const { table, cols, col, hot, keyCols, labelOf } = columnOf(query, ref)
    // a column of one row (a total, `r4@n`) is one value, drawn as one: no chart of one bar
    const series = kind === 'series' && table.length !== 1
    const sections = [...(withRows && hasRows(r) ? [rowsSection(r, series ? 'the series' : 'this value', deep)] : []), codeSection(r, query, ref, deep)]
    if (series) {
      const labels = distinctCut(table.map(t => short(labelOf(t), 200)), 24)
      const rows = table.map((t, j) => ({ label: labels[j], value: typeof t[col] === 'number' ? t[col] : Number(t[col]) || 0 }))
      const labelW = Math.max(4, ...rows.map(x => x.label.length))
      const first = `${fmtN(rows.length)} values of ${col}`
      return { title: label || `${query?.id || ''} ${col}`, right, parts: [{ program: SERIES_PROGRAM, data: { about, rows, room: room - 2, labelW, col: col || 'value', first, behind: behindLine(r, files) } }], sections, links: [] }
    }
    const values = cols.filter(c => !keyCols.includes(c))
    // a citation of the whole query: where it shows the values the words state (resolve's `shown`), its output rows
    // that hold them, else the lines it printed
    const sh = r.shown && typeof r.shown === 'object' ? r.shown : null
    const held = hot < 0 && sh && Array.isArray(sh.rows) ? sh.rows.filter(i => Number.isInteger(i) && table[i]) : []
    if (hot < 0 && !held.length && sh && Array.isArray(sh.lines) && sh.lines.length && query?.code) {
      return { ...printedCard(label, right, query, sh, room), sections }
    }
    const at = hot >= 0 && table[hot] ? hot : kind === 'series' ? 0 : -1
    const value = at >= 0 && table[at] ? table[at][col] : (r.chain || []).find(c => c.step === 'query' && 'value' in c)?.value
    // the cited value as the reply wrote it (a share as a percent when the words write a percent), its column alike
    const form = citedForm(value, label)
    const show = (c, v) => (form && c === col && typeof v === 'number' ? inForm(v, form) : cellText(v))
    // one value: the value and what it counts
    if (table.length <= 1 && (values.length <= 1 || kind === 'series')) {
      const what = `{dim:${esc(query?.id || '')}${query?.about ? ' ·' : ''}} ${esc(query?.about || 'the query')}${col && !['value', 'n', 'count'].includes(col) ? ` {dim:· ${esc(col)}}` : ''}`
      return { title: label, right, parts: [{ program: VALUE_PROGRAM, data: { value: value == null ? label : form ? inForm(value, form) : fmtN(value), what, behind: behindLine(r, files) } }], sections, links: [] }
    }
    // the columns that fit: the key's first, then the cited one, then the others
    const order = [...keyCols, ...(col && !keyCols.includes(col) ? [col] : []), ...values.filter(c => c !== col)].slice(0, 5)
    const fit = Math.max(2, room - (about ? 1 : 0) - 1 - 2)
    const hots = held.length ? held : [hot]
    let start = 0
    if (table.length > fit) start = Math.max(0, Math.min(table.length - fit, hots[0] - Math.floor((fit - (hots[hots.length - 1] - hots[0])) / 2)))
    let pick = table.slice(start, start + fit).map((_, j) => start + j)
    // rows that hold the values too far apart for one window: each of them, a gap row between
    if (held.length && held.some(i => !pick.includes(i))) pick = held.slice(0, fit)
    const gap = order.map(() => '⋯')
    const rows = []
    pick.forEach((i, j) => {
      if (j && i > pick[j - 1] + 1) rows.push({ cells: gap, hot: false })
      rows.push({ cells: order.map(c => show(c, table[i][c])), hot: hots.includes(i) })
    })
    // the rows around the cited one; the whole output is one key away (expand)
    const more = ''
    return {
      title: label, right, sections, links: [],
      parts: [{ program: QUERY_PROGRAM, data: { about, cols: order.map(c => ({ label: short(c, 20), align: table.some(t => typeof t[c] === 'number') ? 'right' : 'left' })), rows, hotCol: order.indexOf(held.length && sh.cols?.[0] ? sh.cols[0] : col), more, behind: behindLine(r, files) } }],
    }
  }
  if (kind === 'object') {
    const step = (r.chain || []).find(c => c.step === 'object') || {}
    const sections = [...(withRows && hasRows(r) ? [rowsSection(r, 'this value', deep)] : []), codeSection(r, null, ref, deep)]
    const value = 'value' in step ? `{dim:value} **${esc(short(typeof step.value === 'object' ? JSON.stringify(step.value) : step.value, 60))}**${step.at ? ` {dim:at ${esc(step.at)}}` : ''}` : ''
    if (object && typeof object.program === 'string' && object.program.trim()) {
      const parts = [{ program: object.program, data: object.data ?? {}, id: object.id || step.id }]
      const words = [value, behindLine(r, files)].filter(Boolean)
      if (words.length) parts.push({ program: LINES_PROGRAM, data: { lines: words } })
      return { title: label, right: `cite · ${short(object.title || step.id || ref, 40)}`, parts, sections, mark: Array.isArray(step.marks) ? step.marks : [ref], links: [] }
    }
    const recs = rowsSection(r, 'this value', room)
    return { title: label, right, parts: [{ program: RECORDS_PROGRAM, data: { ...recs.parts[0].data, head: value || recs.parts[0].data.head } }], sections: [codeSection(r, null, ref, deep)], links: [] }
  }
  // a quote or lines of a file: the cited span, a few rows around it
  if (r.span && Array.isArray(r.span.rows) && r.span.rows.length) {
    const sections = r.span.raw && r.span.kind !== 'text' && r.span.kind !== 'markdown' && r.span.kind !== 'diff' && r.span.kind != null ? [rawSection(r.span, deep)] : []
    return { title: label, right: `cite · ${short(r.span.path || files || ref, 40)}`, parts: [spanPart(r.span, room)], sections, links: [] }
  }
  if (kind === 'code' && Array.isArray(lines) && lines.length) {
    const m = /#L(\d+)(?:-L?(\d+))?$/.exec(ref)
    const a = Number(m?.[1] || 0)
    const b = Number(m?.[2] || a)
    const file = path || ref.split('#')[0]
    const sp = { rows: lines.slice(0, room).map(l => ({ n: l.n, text: String(l.text).replace(/\t/g, '    ').slice(0, 300), hot: l.n >= a && l.n <= b })), cited: b - a + 1, unit: 'line' }
    return { title: label, right: `cite · ${short(file.replace(/^.*\//, ''), 40)}`, parts: [spanPart(sp, room)], sections: [], links: [] }
  }
  // rows of a source the kernel gave no span for (a whole file, a table): a few of them, as words
  const recs = rowsSection(r, label ? `"${short(label, 40)}"` : 'it', room)
  return { title: label, right, parts: recs.parts, sections: [], links: [] }
}

/** A gloss's explain card: what the term is, its tiny drawing, and where it mattered in this work. Three parts,
 *  drawn one under the other with a blank row between: a drawing that fails leaves the words as they are. */
export function explainerCard({ gloss, heal = null }) {
  const g = gloss || {}
  const look = healLook(heal)
  if (g.kind === 'heads') return headsCard(g, look)
  const links = linksIn(`${g.body || ''}\n${g.here || ''}`, look)
  const words = md => ({ program: WORDS_PROGRAM, data: { text: linkedText(md, links, look), links: links.filter(l => String(linkedText(md, links, look)).includes(`(#${l.id})`)) } })
  const parts = [words(g.body || g.title || '')]
  if (typeof g.program === 'string' && g.program.trim()) parts.push({ program: g.program, data: g.data && typeof g.data === 'object' ? g.data : {}, pic: true })
  if (g.here) parts.push(words(g.here))
  return { title: g.term || g.title || 'explain', right: g.expanded ? 'explain · expanded' : 'explain', parts, links }
}

/** An important detail's card (a gloss of kind 'heads'): its title, two to four bullets with their citations, and one
 *  line on what to do, as a "heads up" note reads. */
function headsCard(g, look = null) {
  const bullets = (Array.isArray(g.bullets) ? g.bullets : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 4)
  const links = linksIn([...bullets, g.todo || ''].join('\n'), look)
  const md = [g.title ? `**${String(g.title).replace(/\*/g, '')}**` : '', ...bullets.map(x => `• ${x}`), g.todo ? `→ ${g.todo}` : ''].filter(Boolean).join('\n')
  return { title: g.term || g.title || 'heads up', right: 'heads up', parts: [{ program: WORDS_PROGRAM, data: { text: linkedText(md, links, look), links } }], links }
}

/** A citation of a whole file: a path with no `#`, not a query's or a card's value. */
export const wholeFile = ref => { const r = String(ref || ''); return !!r && !r.includes('#') && !/^([qr]\d+(@|$)|obj:|card:)/.test(r) && /\.[A-Za-z0-9]{1,10}$/.test(r) }

/** A citation's card, its inputs read through `io` ({resolve(ref, n, label), read(path)}): the ref resolved (a series
 *  by its query), the query's record, the object's record for a value of a card, the code file's lines. */
export async function citeCard({ ref, label, root, room = 9 }, io) {
  const series = seriesRef(ref)
  const resolved = await io.resolve(series ? series.query : ref, 6, series ? undefined : label)
  let query = null
  const q = /^([qr]\d+)(?:[#@]|$)/.exec(typeof resolved?.narrowed === 'string' && resolved.narrowed ? resolved.narrowed : ref)
  if (q) {
    try { query = JSON.parse(String(await io.read(`${root}/thimble/queries/${q[1]}.json`))) } catch { query = null }
  }
  // a value of a card: the card itself, to draw with the part that holds the value marked
  let object = null
  const step = (resolved?.chain || []).find(c => c && c.step === 'object')
  if (cardKind(ref) === 'object' && step?.id && /^[\w.-]+$/.test(String(step.id))) {
    try { object = JSON.parse(String(await io.read(`${root}/thimble/objects/${step.id}.json`))) } catch { object = null }
  }
  let lines
  const path = ref.split('#')[0]
  // a whole file (`plugin/prompts/context.md`): its top, read as it is, as a citation of its lines shows them
  if (wholeFile(ref)) {
    try {
      const all = String(await io.read(path.startsWith('/') ? path : `${root}/${path}`)).split('\n')
      const top = all.slice(0, room).map((text, i) => ({ n: i + 1, text: String(text).replace(/\t/g, '    ').slice(0, 300), hot: false }))
      const more = all.length > top.length ? `the first ${top.length} of its ${fmtN(all.length)} lines` : ''
      const file = fileLink(ref, root)
      return { title: label, right: `cite · ${short(path, 40)}`, parts: [{ program: SPAN_PROGRAM, data: { rows: top.map(r => ({ ...r, n: String(r.n), text: esc(r.text) })), hotMax: 1, more, plain: true } }], sections: [], links: [], ...(file ? { file } : {}) }
    } catch {
      // a file it cannot read: the kernel's card, below
    }
  }
  if (cardKind(ref) === 'code' && !resolved?.span) {
    const m = /#L(\d+)(?:-L?(\d+))?$/.exec(ref)
    const a = Number(m?.[1] || 1)
    const b = Number(m?.[2] || a)
    try {
      const all = String(await io.read(path.startsWith('/') ? path : `${root}/${path}`)).split('\n')
      const from = Math.max(1, a - 2)
      const to = Math.min(all.length, Math.max(b + 2, from + room - 2))
      lines = []
      for (let n = from; n <= to; n++) lines.push({ n, text: all[n - 1] ?? '' })
    } catch {
      lines = undefined
    }
  }
  const card = sourceCard({ ref, label, resolved, query, object, lines, path, room })
  // the file a source citation names, for a surface that links to it (the terminal, as Claude Code links a file)
  const file = fileLink(ref, root)
  const out = file ? { ...card, file } : card
  // a value with no rows behind it says why, in one line (the kernel's `why`)
  return resolved && typeof resolved.why === 'string' && resolved.why ? { ...out, why: resolved.why } : out
}

/** A card spec drawn as a tray wants it: each part by `draw(part)` (a host's sandbox: the terminal's prep.mjs, the
 *  browser's own), the sections' parts too, all at once. A part that fails stops the card with one line that says why,
 *  unless it is a picture (a gloss's drawing), which is left out; a section that fails says so in its place. */
export async function drawnCard(spec, draw) {
  if (!spec || spec.problem || spec.error) return { title: spec?.title, right: spec?.right, problem: String(spec?.problem || spec?.error || 'no card'), drawings: [], links: [] }
  const drawAll = async parts => {
    const got = await Promise.all((parts || []).map(p => Promise.resolve().then(() => draw(p)).then(d => ({ d }), err => ({ err }))))
    const out = []
    for (let i = 0; i < got.length; i++) {
      const { d, err } = got[i]
      const pic = !!(parts[i] && parts[i].pic)
      if (err || !d) { if (pic) continue; throw new Error(`the card could not be drawn: ${String(err?.message || err || 'no drawing').slice(0, 160)}`) }
      if (d.error && pic) continue
      out.push(pic ? { ...d, pic: true } : d)
    }
    return out
  }
  const { parts, sections, ...rest } = spec
  const [main, ...more] = await Promise.all([
    drawAll(parts).then(d => ({ d }), err => ({ err })),
    ...(sections || []).map(s => drawAll(s.parts).then(d => ({ d }), err => ({ err }))),
  ])
  if (main.err) return { title: spec.title, right: spec.right, problem: String(main.err.message || main.err), drawings: [], links: [] }
  return {
    ...rest, links: spec.links || [], drawings: main.d,
    sections: (sections || []).map((s, i) => ({ id: s.id, key: s.key, words: s.words, ...(s.note ? { note: s.note } : {}), drawings: more[i].d || [], ...(more[i].err ? { problem: String(more[i].err.message || more[i].err) } : {}) })),
  }
}
