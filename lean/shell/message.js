// message.js: one message of Claude's as the message layer sees it: its marks, its blocks and how they wrap. No `$`,
// no DOM, no Node: the hooks module, the Node helpers, the browser page and the tests all import it.
//
// A mark is a span of the shown text (the record's `shown`, else its `text`: Claude's markdown as written):
//   cite   {kind: 'cite', start, end, ref, label}       a link to a kernel ref, `[6,543](q1#day=2026-06-18@n)`
//   spark  {kind: 'spark', start, end, ref, values}     a link whose words are `~`, `[~](q4@n)`: a series drawn inline
//   gloss  {kind: 'gloss', start, end, gloss}          a term the observer explains, found by its words
// `start` and `end` are string offsets into the shown markdown and cover the mark as written: a cite's or a spark's whole
// link, a gloss's words. Marks are in text order and never overlap.
//
//   linkMarks(text)                  -> the cites and sparks Claude wrote
//   placeMarks(text, glosses, prev)  -> every mark of the text: its links, then each gloss's term where it first stands
//                                       outside a link or code; a spark keeps the values `prev` resolved for its ref
//   seriesRef(ref)                   -> {query, col} for a spark's ref (q4@n, q4#n), or null
//   sparkChars(values)               -> the sparkline's glyphs, ▁ to ▇, scaled from 0 (or the least value below 0)
//   blocks(text)                     -> the markdown's blocks with their offsets
//   inline(text, from, to, marks)    -> one block's content as runs: words with their style, and each mark as one run
//   wrapRuns(runs, width)            -> the runs cut into lines at spaces; a mark never breaks
//   tableOf(text, block, marks)      -> a table block's cells as runs
import { isRef } from './object.js'

const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
const SPARK_LABEL = /^\s*~\s*$/

/** Where code stands in markdown: fenced blocks and inline code spans, as [start, end) ranges. */
export function codeRanges(text) {
  const s = String(text || '')
  const out = []
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[`~]*[ \t]*(?=\n|$)|$)/gm
  for (const m of s.matchAll(fence)) out.push([m.index, m.index + m[0].length])
  const inFence = i => out.some(([a, b]) => i >= a && i < b)
  const span = /(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g
  for (const m of s.matchAll(span)) if (!inFence(m.index)) out.push([m.index, m.index + m[0].length])
  return out.sort((a, b) => a[0] - b[0])
}

const inside = (ranges, a, b) => ranges.some(([x, y]) => a < y && b > x)

/** A spark's series: `q4@n` or `q4#n` (the column n of q4's output, in its row order). */
export function seriesRef(ref) {
  const m = /^(q\d+)(?:@|#)([A-Za-z_][\w .-]*)$/.exec(String(ref || '').trim())
  if (!m || m[2].includes('=')) return null
  return { query: m[1], col: m[2].trim() }
}

/** Whether a link target is one the layer marks: a kernel ref, or a spark's series. */
function markable(ref) {
  return !/^(https?|file|mailto):/i.test(ref) && (isRef(ref) || !!seriesRef(ref))
}

/** The cites and sparks Claude wrote, in text order. */
export function linkMarks(text) {
  const s = String(text || '')
  const code = codeRanges(s)
  const out = []
  for (const m of s.matchAll(LINK)) {
    const ref = String(m[2]).trim()
    const start = m.index
    const end = start + m[0].length
    if (inside(code, start, end) || !markable(ref)) continue
    if (SPARK_LABEL.test(m[1])) out.push({ kind: 'spark', start, end, ref, values: null })
    else if (isRef(ref)) out.push({ kind: 'cite', start, end, ref, label: labelOf(m[1], ref) })
  }
  return out
}

/** A citation's words, without its markdown; one whose words are only a sign (`↗`) is named by its place. */
function labelOf(words, ref) {
  const w = String(words).replace(/[*_`]/g, '').trim()
  return /[\p{L}\p{N}]/u.test(w) ? w : String(ref).replace(/#L(\d+)/, ':$1').replace(/^obj:/, '')
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where a gloss's term first stands: a whole-word match outside links and code, the exact case first. */
export function findTerm(text, term, taken = []) {
  const t = String(term || '').trim()
  if (!t || t.length > 120) return null
  const s = String(text || '')
  const blocked = [...codeRanges(s), ...taken.map(m => [m.start, m.end])]
  // link targets are blocked too, so a term is never found inside a ref
  for (const m of s.matchAll(LINK)) blocked.push([m.index, m.index + m[0].length])
  const edge = '(?<![\\p{L}\\p{N}_])'
  const tail = '(?![\\p{L}\\p{N}_])'
  for (const flags of ['gu', 'giu']) {
    const re = new RegExp(edge + escapeRe(t).replace(/\s+/g, '\\s+') + tail, flags)
    for (const m of s.matchAll(re)) {
      const a = m.index
      const b = a + m[0].length
      if (!inside(blocked, a, b)) return { start: a, end: b }
    }
  }
  // a term written as code (`pytest-xdist`): the whole code span, backticks and all
  const want = t.toLowerCase().replace(/\s+/g, ' ')
  for (const [a, b] of codeRanges(s)) {
    const inner = s.slice(a, b)
    if (/^`+[^`]/.test(inner) && inner.replace(/^`+|`+$/g, '').trim().toLowerCase().replace(/\s+/g, ' ') === want && !inside(taken.map(m => [m.start, m.end]), a, b)) return { start: a, end: b }
  }
  return null
}

/**
 * Every mark of the text: the links Claude wrote, then each gloss placed by its term. `glosses` is the record's
 * `{id: {term, ...}}`; a gloss whose term is not in the text gets no mark. `prev` (the marks before a change of the
 * text) gives each spark the values already resolved for its ref.
 */
export function placeMarks(text, glosses = {}, prev = []) {
  const marks = linkMarks(text)
  for (const m of marks) {
    if (m.kind !== 'spark') continue
    const old = (prev || []).find(p => p.kind === 'spark' && p.ref === m.ref && Array.isArray(p.values))
    if (old) m.values = old.values
  }
  for (const [id, g] of Object.entries(glosses || {})) {
    const at = findTerm(text, g && g.term, marks)
    if (at) marks.push({ kind: 'gloss', start: at.start, end: at.end, gloss: id })
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
    let j = i + 1
    while (j < lines.length && !blank(j) && !FENCE.test(lines[j].line) && !HEAD.test(lines[j].line) && !ITEM.exec(lines[j].line) && !/^\s*>/.test(lines[j].line) && !RULE.test(lines[j].line) && !(lines[j].line.includes('|') && j + 1 < lines.length && TABLE_SEP.test(lines[j + 1].line))) j++
    out.push({ type: 'para', start: L.start, end: lines[j - 1].end, from: L.start, to: lines[j - 1].end, gap })
    i = j; gap = false
  }
  return out
}

/** The marks that lie inside [from, to). */
export const marksIn = (marks, from, to) => (marks || []).map((m, i) => ({ ...m, i })).filter(m => m.start >= from && m.end <= to)

// ------------------------------------------------------------------------------------------------ inline runs

/**
 * One block's content (text[from..to)) as runs: `{s, b?, it?, code?, link?, mark?}` where `mark` is the mark's index in
 * the record's marks. Bold, italic and inline code as Claude Code draws them; a link that is no mark reads as its words
 * then its target, as Claude Code draws one; line breaks inside a block are spaces.
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
  let i = from
  while (i < to) {
    const mk = mine.find(m => m.start === i)
    if (mk) {
      const raw = s.slice(mk.start, mk.end)
      const asCode = mk.kind === 'gloss' && raw.startsWith('`')
      const words = mk.kind === 'gloss' ? raw.replace(/^`+|`+$/g, '').replace(/\s+/g, ' ') : mk.kind === 'spark' ? sparkChars(mk.values || []) : mk.label
      push(words, { mark: mk.i, ...(asCode ? { code: true } : {}) })
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
      LINK.lastIndex = 0
      const m = /^\[([^\]\n]+)\]\(([^)\n]+)\)/.exec(s.slice(i, to))
      if (m) { push(m[1], { link: true }); if (!/^(https?|file):/i.test(m[2])) push(` (${m[2]})`, { dim: true }); i += m[0].length; continue }
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
 * The runs cut into lines of at most `w` cells, at spaces. A mark (`mark` set) is never cut, unless it is wider than a
 * line; a word wider than a line is cut where the line ends. Each line is a list of runs; the space a line breaks on
 * is dropped.
 */
export function wrapRuns(runs, w) {
  const W = Math.max(8, w)
  // pieces: words with their spaces, a mark whole
  const pieces = []
  for (const r of runs) {
    if (r.mark !== undefined) { pieces.push({ ...r, sp: false }); continue }
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
    else if (last && last.mark !== undefined && x.mark === last.mark) last.s += x.s
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
  return { ...rec, marks: placeMarks(shownOf(rec), rec.glosses || {}, rec.marks || []) }
}

/** The record for a message whose words are `text`: the kept record when its words are the same, else a new one that
 *  keeps the kept one's glosses, verbs and objects (a summary row, a resumed session). */
export function recordFor(kept, { row, session, text, at }) {
  if (kept && kept.text === String(text ?? '')) return kept
  const rec = newRecord({ row, session, text, at: at || kept?.at })
  if (!kept) return rec
  return remark({ ...rec, ...(kept.uuid ? { uuid: kept.uuid } : {}), glosses: kept.glosses || {}, verbs: kept.verbs || {}, objects: kept.objects || [], final: !!kept.final })
}

const VERB_KEYS = ['v', 's', 'c']
const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')

/**
 * The observer's verbs as the record keeps them: each of v, s and c, lit only when the observer gave it, with its
 * note of 2–4 words; v's proposals (at most 2), s's chips (dimensions with levels, at most 3), c's new claims (ids).
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
      r.proposals = (Array.isArray(v.proposals) ? v.proposals : []).map(p => str(typeof p === 'string' ? p : p?.title, 60)).filter(Boolean).slice(0, 2)
      if (!r.proposals.length && !note) continue
    }
    if (k === 's') {
      // where the answer stands on the squeeze's fixed chips, by a level's name: {interpret: 'report', familiarity: 'expert'}
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
    if (k === 'c') r.claims = (Array.isArray(v.claims) ? v.claims : []).filter(x => typeof x === 'string').slice(0, 60)
    if (!r.note) r.note = k === 'v' ? `${r.proposals.length} view${r.proposals.length === 1 ? '' : 's'} ready` : ''
    // s may carry only where the answer stands on its chips: kept, and not lit
    if (!r.note && k === 's' && r.at && Object.keys(r.at).length) { res[k] = { ...r, lit: false }; continue }
    if (!r.note) continue
    res[k] = r
  }
  return res
}

/**
 * The observer's glosses as the record keeps them, `{g1: {term, title, body, here, program, refs}}`: at most three,
 * each a term found in the text (a term the text does not hold is dropped, so no gloss points at nothing), none whose
 * term is in `skip` (terms the person already saw explained).
 */
export function glossesOf(list, text, skip = []) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const seen = new Set((skip || []).map(norm))
  const out = {}
  let n = 0
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || typeof g !== 'object') continue
    const term = str(g.term, 80)
    if (!term || seen.has(norm(term)) || !findTerm(text, term)) continue
    seen.add(norm(term))
    const refs = (Array.isArray(g.refs) ? g.refs : []).filter(r => typeof r === 'string' && isRef(r)).slice(0, 6)
    out[`g${++n}`] = { term, title: str(g.title, 80) || term, body: str(g.body, 500), here: str(g.here, 400), program: typeof g.program === 'string' ? g.program.slice(0, 3000) : '', refs }
    if (n >= 3) break
  }
  return out
}

/** The record with what the observer gave for it: its lit verbs and its glosses, the marks placed again. */
export function withObserver(rec, { verbs, glosses } = {}) {
  return remark({ ...rec, verbs: verbs || {}, glosses: glosses || {} })
}
