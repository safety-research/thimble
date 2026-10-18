// cards.js: the tray's cards, each an object the drawing contract draws (program + data), so the terminal and the
// browser draw the same card. No `$`, no Node, no DOM: the shell gathers what a card reads through the kernel (`lean
// resolve --json`, the query's record, the lines of a code file) and hands it in.
//
//   cardKind(ref)                                   -> 'query' | 'series' | 'code' | 'rows' | 'object'
//   sourceCard({ref, label, resolved, query, lines, path})  -> {title, right, parts: [{program, data}], links}
//       a citation's card, whichever fits its ref: the query's output as bars around the cited row, a series as a
//       small plot, a code hunk with the cited lines lit, or a table of the cited rows; with one `from` line
//   explainerCard({gloss})                          -> {title, right, parts, links}
//       a gloss's card: what the term is, a tiny drawing when the observer gave a program, where it mattered here
//   linksIn(markdown)                               -> the kernel refs a card's words cite, each a nested mark
// A card is drawn part by part (`parts`, each a program and its data), a blank row between parts.
// `links` are the nested marks a card holds, in reading order: [{id, ref, label}]. Their words carry a small digit
// (¹ ² ³), the key that opens one from an empty prompt.
import { isRef } from './object.js'
import { seriesRef } from './message.js'

const SUP = ['¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹']
const CODE = /\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|sh|bash|zsh|sql|r|jl|scala|swift|cs|lua|pl|toml|ya?ml|ini|cfg|conf|md|rst|txt|log|html|css|scss|vue|svelte|tf|dockerfile)$/i

/** Which card a ref gets. */
export function cardKind(ref) {
  const r = String(ref || '')
  if (seriesRef(r)) return 'series'
  if (/^q\d+(?:#|$)/.test(r)) return 'query'
  if (r.startsWith('obj:')) return 'object'
  const path = r.split('#')[0]
  if (CODE.test(path) && /#L\d+(?:-L?\d+)?$/.test(r)) return 'code'
  return 'rows'
}

/** The kernel refs a card's words cite (`[words](ref)`), each once, as nested marks. */
export function linksIn(md) {
  const out = []
  for (const m of String(md || '').matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    const ref = String(m[2]).trim()
    if (!isRef(ref) || out.some(x => x.ref === ref)) continue
    out.push({ id: `n${out.length + 1}`, ref, label: String(m[1]).replace(/[*_`]/g, '') })
  }
  return out.slice(0, SUP.length)
}

/** Card words with each nested mark as a toolkit link to its cite (`[words¹](#n1)`), other markup escaped. */
export function linkedText(md, links) {
  const esc = s => String(s).replace(/`([^`\n]+)`/g, '$1').replace(/[\\{}[\]*]/g, c => '\\' + c)
  let out = ''
  let i = 0
  const s = String(md || '')
  for (const m of s.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    out += esc(s.slice(i, m.index)).replace(/\\\*\\\*([^*]+?)\\\*\\\*/g, '**$1**')
    const k = links.findIndex(x => x.ref === String(m[2]).trim())
    out += k >= 0 ? `[${esc(String(m[1]).replace(/[*_`]/g, ''))}${SUP[k]}](#${links[k].id})` : esc(m[1])
    i = m.index + m[0].length
  }
  return out + esc(s.slice(i)).replace(/\\\*\\\*([^*]+?)\\\*\\\*/g, '**$1**')
}

const fmtN = v => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v ?? ''))
const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…' }

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
  const m = /^q\d+(?:#(.*?))?(?:@([^@]+))?$/.exec(String(ref))
  const frag = m?.[1] || ''
  const keys = Array.isArray(query?.keys) ? query.keys : []
  let col = m?.[2] || null
  let hot = -1
  if (/^row=(\d+)$/.test(frag)) hot = Number(frag.slice(4)) - 1
  else if (frag && frag.includes('=')) {
    const want = Object.fromEntries(frag.split('&').map(p => { const j = p.indexOf('='); return [decodeURIComponent(p.slice(0, j)), decodeURIComponent(p.slice(j + 1))] }))
    hot = table.findIndex(r => Object.entries(want).every(([k, v]) => String(r[k]) === v))
  } else if (frag && !col) col = frag
  const cols = table.length ? Object.keys(table[0]).filter(k => !k.startsWith('_')) : []
  if (!col) col = cols.find(c => typeof table[0]?.[c] === 'number' && !keys.includes(c)) || cols[cols.length - 1] || null
  // the words a row is named by: its key columns, unless the key is only a row number (a frame's index), then its
  // first column of words
  const named = keys.filter(k => cols.includes(k) && k !== 'index' && !(table.length && table.every(r => Number.isInteger(r[k])) && k.endsWith('index')))
  const words = cols.filter(c => c !== col && table.some(r => typeof r[c] === 'string'))
  const keyCols = named.length ? named : words.length ? words.slice(0, 1) : cols.filter(c => c !== col).slice(0, 1)
  const labelOf = r => keyCols.map(k => (r[k] === '' || r[k] == null ? '(none)' : String(r[k]))).join(' · ') || ''
  return { table, col, hot, keyCols, labelOf }
}

// ------------------------------------------------------------------------------------------------ programs

const QUERY_PROGRAM = `
const items = data.rows.map(r => ({ label: r.label, value: r.value, tone: r.hot ? 'accent' : 'c4', bold: r.hot }))
const parts = []
if (items.length) parts.push(k.bars(items, { labelW: Math.min(data.labelW, Math.floor(k.w * 0.4)) }))
else parts.push(k.text(data.value != null ? '**' + k.escape(String(data.value)) + '**' : '{dim:no value}'))
if (data.more) parts.push(k.text('{dim:' + k.escape(data.more) + '}'))
for (const r of data.records) parts.push(k.text('{dim:' + k.escape(r.ref) + '}  ' + k.escape(r.text), { wrap: false }))
parts.push(k.text(data.from, { wrap: false }))
return k.stack(parts)`

const SERIES_PROGRAM = `
const parts = []
if (data.rows.length <= data.room) {
  parts.push(k.bars(data.rows.map(r => ({ label: r.label, value: r.value, tone: 'accent' })), { labelW: Math.min(data.labelW, Math.floor(k.w * 0.4)) }))
} else {
  const n = data.rows.length
  const ticks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => ({ at: i, label: data.rows[i].label }))
  parts.push(k.plot([{ name: data.col, values: data.rows.map(r => r.value) }], { h: Math.max(3, data.room - 1), legend: false, x: { ticks } }))
  parts.push(k.text('{dim:' + k.escape(data.first) + '}', { wrap: false }))
}
parts.push(k.text(data.from, { wrap: false }))
return k.stack(parts)`

const CODE_PROGRAM = `
const nw = String(data.lines.length ? data.lines[data.lines.length - 1].n : 1).length
const rows = data.lines.map(l => k.beside(
  k.text((l.hot ? '{accent:' : '{dim:') + String(l.n).padStart(nw) + '}' + (l.hot ? ' {accent:▌}' : '  '), { w: nw + 2, wrap: false }),
  k.text(l.text || ' ', { raw: true, wrap: false, tone: l.hot ? 'ink' : 'dim', bold: !!l.hot }),
  { gap: 1 }))
return k.stack(k.text('{dim:' + k.escape(data.head) + '}', { wrap: false }), ...rows, data.note ? k.text(data.note, { wrap: false }) : false)`

const ROWS_PROGRAM = `
const parts = []
const w = Math.max(...data.rows.map(r => r.ref.length), 4)
for (const r of data.rows) parts.push(k.beside(
  k.text((r.hot ? '{accent:' : '{dim:') + k.escape(r.ref) + '}', { w, wrap: false }),
  k.text(k.escape(r.text), { wrap: data.rows.length === 1, max: data.rows.length === 1 ? data.room : 1, bold: !!r.hot }),
  { gap: 2 }))
if (!data.rows.length) parts.push(k.text('{dim:' + k.escape(data.empty) + '}'))
if (data.more) parts.push(k.text('{dim:' + k.escape(data.more) + '}'))
parts.push(k.text(data.from, { wrap: false }))
return k.stack(parts)`

const WORDS_PROGRAM = `
for (const l of data.links) k.cite(l.id, { text: l.label, ref: l.ref })
return k.text(data.text)`

// ------------------------------------------------------------------------------------------------ cards

/**
 * A citation's card. `resolved` is `lean resolve <ref> --json`; `query` the query's record (thimble/queries/q<n>.json)
 * for a query ref; `lines` the file's lines around the cited ones, for a code ref ({n, text}); `room` the card's rows.
 */
export function sourceCard({ ref, label, resolved, query, lines, path, room = 9 }) {
  const kind = cardKind(ref)
  const r = resolved || {}
  const count = r.count != null ? `${fmtN(r.count)} source row${r.count === 1 ? '' : 's'}` : ''
  const files = filesOf(r, query)
  const fromParts = []
  if (files) fromParts.push(files)
  if (query?.about) fromParts.push(short(query.about, 48))
  if (count) fromParts.push(count)
  const from = `{dim:from} ${fromParts.map(p => p.replace(/[{}[\]\\*]/g, '')).join(' {dim:·} ')}`
  const right = `cite · ${short(files || ref, 40)}`
  if (r.error && kind !== 'code') {
    return { title: label, right, parts: [{ program: ROWS_PROGRAM, data: { rows: [], empty: `${ref} does not resolve: ${short(r.error, 200)}`, more: '', from: '{dim:lean resolve gave no rows}', room } }], links: [] }
  }
  if (kind === 'query' || kind === 'series') {
    const { table, col, hot, labelOf } = columnOf(query, ref)
    const recs = (r.records || []).slice(0, kind === 'query' && hot >= 0 ? 1 : 0).map(x => ({ ref: short(String(x.ref).replace(/^.*\//, ''), 28), text: short(x.text, 140) }))
    if (kind === 'series') {
      const rows = table.map(t => ({ label: short(labelOf(t), 24), value: typeof t[col] === 'number' ? t[col] : Number(t[col]) || 0 }))
      const labelW = Math.max(4, ...rows.map(x => x.label.length))
      const first = rows.length ? `${rows[0].label} … ${rows[rows.length - 1].label} · ${rows.length} rows of ${col}` : ''
      return { title: label || `${query?.id || ''} ${col}`, right, parts: [{ program: SERIES_PROGRAM, data: { rows, room: room - 1, labelW, col: col || 'value', first, from } }], links: [] }
    }
    const fit = Math.max(2, room - 1 - recs.length - 1)
    let start = 0
    if (table.length > fit) start = Math.max(0, Math.min(table.length - fit, hot - Math.floor(fit / 2)))
    const win = table.slice(start, start + fit)
    const num = win.length && win.every(t => typeof t[col] === 'number')
    const rows = num ? win.map((t, j) => ({ label: short(labelOf(t), 28), value: t[col], hot: start + j === hot })) : []
    const value = hot >= 0 && table[hot] ? table[hot][col] : null
    const more = table.length > win.length ? `${win.length} of ${fmtN(table.length)} rows of ${query?.id || 'the query'}` : ''
    return {
      title: label, right, links: [],
      parts: [{ program: QUERY_PROGRAM, data: { rows, value, more, records: recs, from, labelW: Math.max(4, ...rows.map(x => x.label.length)) } }],
    }
  }
  if (kind === 'code' && Array.isArray(lines) && lines.length) {
    const m = /#L(\d+)(?:-L?(\d+))?$/.exec(ref)
    const a = Number(m?.[1] || 0)
    const b = Number(m?.[2] || a)
    const file = path || ref.split('#')[0]
    return {
      title: label, right: `cite · ${short(file.replace(/^.*\//, ''), 40)}`, links: [],
      parts: [{ program: CODE_PROGRAM, data: { head: `${file}  line${b > a ? `s ${a}–${b}` : ` ${a}`}`, lines: lines.slice(0, room - 1).map(l => ({ n: l.n, text: String(l.text).replace(/\t/g, '    ').slice(0, 300), hot: l.n >= a && l.n <= b })), note: '' } }],
    }
  }
  // rows of a source, or an object's value with the rows behind it
  const recs = r.records || []
  const one = recs.length === 1
  const rows = recs.slice(0, Math.max(1, room - 2)).map(x => ({ ref: short(String(x.ref).replace(/^.*\//, ''), 30), text: String(x.text || ''), hot: String(x.ref) === ref }))
  const total = r.count != null ? r.count : recs.length
  const more = total > rows.length ? `${rows.length} of ${fmtN(total)} rows, the first in file order` : ''
  const objStep = (r.chain || []).find(c => c.step === 'object')
  const value = objStep && 'value' in objStep ? `{dim:value} **${String(typeof objStep.value === 'object' ? JSON.stringify(objStep.value) : objStep.value).slice(0, 60).replace(/[{}[\]\\*]/g, '')}** {dim:in} ${String(objStep.title || objStep.id).replace(/[{}[\]\\*]/g, '')}` : ''
  return {
    title: label, right, links: [],
    parts: [{ program: ROWS_PROGRAM, data: { rows, more: value ? value : more, empty: 'no rows', from, room: one ? room - 2 : 1 } }],
  }
}

/** A gloss's explainer card: what the term is, its tiny drawing, and where it mattered in this work. Three parts,
 *  drawn one under the other with a blank row between: a drawing that fails leaves the words as they are. */
export function explainerCard({ gloss }) {
  const g = gloss || {}
  const links = linksIn(`${g.body || ''}\n${g.here || ''}`)
  const words = md => ({ program: WORDS_PROGRAM, data: { text: linkedText(md, links), links: links.filter(l => String(md).includes(`(${l.ref})`)) } })
  const parts = [words(g.body || g.title || '')]
  if (typeof g.program === 'string' && g.program.trim()) parts.push({ program: g.program, data: g.data && typeof g.data === 'object' ? g.data : {}, pic: true })
  if (g.here) parts.push(words(g.here))
  return { title: g.term || g.title || 'gloss', right: 'gloss', parts, links }
}
