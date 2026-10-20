// coverage.js: what this session did with the folder's files, a program on the card runtime (draw/kit.js) over
// `thimble coverage --json` (engine/kernel/lineage.py coverage). It opens in the side panel (shell/side.ts openSide) as
// a thread: a question typed under it is about the group, file or lines selected, and carries their refs. The bar's
// `coverage 34%` opens it (a click, or r). It says in one sentence what Claude read: the rows that entered its
// context (what the kernel calls seen), of all the folder's rows, and in how many of its files. Each group of files has
// one bar of its rows in three parts, which a legend under the sentence names, always in view:
//
//   read      some lines entered Claude's context (the bar's number counts these alone)
//   counted   only counted or computed over: a query, a rule label or a label's model went over them, and none entered
//             Claude's context
//   not touched
//
// Overview first, then zoom, then details on demand:
//
//   overview   the sentence and the legend; then the files grouped by wildcard pattern (`runs/*.jsonl`, the `*` lit,
//              so it is clear which files a row stands for), or by file type, each group with its files, its rows and
//              its bar
//   a group    its files, each with what happened to it: the lines seen, what a label's model read, what was computed
//              over, or why none of its lines entered a context
//   a file     a strip of the whole file with the lines seen lit, the seen ranges, and the file's own lines around the
//              one selected (seen lines marked ▌, those a search showed in its color); a press on a range opens its
//              lines as a citation, over this pane (esc comes back)
//
//   state: {by: 'pattern' | 'type', group: the group open, file: the file open, at: the part selected, range: the range}
//   presses: a group opens its files, a file its lines, a range its lines as a citation; `by pattern` and `by type`
//            group the files. keys: none of its own: the side panel's ring walks the parts (↑ ↓, tab), ↵ presses the one
//            it is on, esc goes back a level (at the top, esc is the panel's: back, or close)
//   wants: {lines: path, from, to} (the file's lines around a range, read by the host)
//   asks of the host: open {mark: {kind: 'cite', ref, label}} (a seen range, as a citation)

import { subjectBlock } from './subject.js'

const STATUS = ['seen', 'model', 'searched', 'computed', 'named', 'not read']
// each status as the pane says it, and its tone
const SAID = { seen: 'read', model: 'computed', searched: 'searched', computed: 'computed', named: 'counted', 'not read': 'not touched' }
const TONE = { seen: 'accent', model: 'dim', searched: 'dim', computed: 'dim', named: 'dim', 'not read': 'unseen' }
// the three parts of a group's bar and the legend's words for them: read into Claude's context, only counted or
// computed over (a label's model too), not touched
export const KEY = [['read', 'accent', "read into Claude's context"], ['counted', 'dim', 'only counted or computed over'], ['untouched', 'dim-faint', 'not touched']]
// the shades of a file's rows: seen, read by a label's model, computed over, untouched
export const PARTS = ['seen', 'model', 'computed', 'untouched']
export const GLYPH = { seen: '█', model: '▓', computed: '▒', untouched: '░' }
// the file types the bar names by color; the others are `other`
const TYPE_TONES = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
const LINES = 400 // characters of one line of a file shown
// the rows the side panel takes under a pane: its input bar, and its thread's conversation when it has one (up to
// two fifths of the panel), so a list that fits shows whole above them, the overview in view
const chromeOf = (k, chat) => 5 + (chat ? Math.floor(k.h * 0.4) : 0)
const n = x => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))
const cut = (s, k) => (Array.from(String(s)).length <= k ? String(s) : Array.from(String(s)).slice(0, Math.max(0, k - 1)).join('') + '…')
const pad = (s, k, right = false) => { const t = cut(s, k); const sp = ' '.repeat(Math.max(0, k - Array.from(t).length)); return right ? sp + t : t + sp }

/** A share as the bar says it (shell.tsx percent): 34%, a decimal under 1%, and 100% only when all. */
export function pct(part) {
  if (!(part > 0)) return '0%'
  if (part >= 1) return '100%'
  const p = 100 * part
  if (p < 0.01) return '<0.01%'
  if (p < 0.1) return `${(Math.floor(p * 100) / 100).toFixed(2)}%`
  if (p < 1) return `${(Math.floor(p * 10) / 10).toFixed(1)}%`
  return `${Math.min(99, Math.round(p))}%`
}

/** A group's rows in the four shades, apart: seen, read by a label's model, computed over, untouched. */
export function partsOf(g) {
  const rows = Math.max(0, g.rows || 0)
  const seen = Math.min(rows, g.seen_rows ?? g.read_rows ?? 0)
  const model = Math.min(rows - seen, g.model_rows || 0)
  const computed = Math.min(rows - seen - model, g.computed_rows || 0)
  return { seen, model, computed, untouched: Math.max(0, rows - seen - model - computed) }
}

/** The file types as the bar draws them: the largest by rows, each with its tone and its rows in the four shades; past
 *  six (or any with no rows), one `other`. Each {type, rows, files, tone, types, seen, model, computed, untouched}. */
export function typeMix(types) {
  const all = (types || []).filter(t => t && t.rows > 0)
  const named = all.slice(0, all.length > TYPE_TONES.length ? TYPE_TONES.length - 1 : TYPE_TONES.length)
  const rest = all.slice(named.length)
  const out = named.map((t, i) => ({ type: t.type, rows: t.rows, files: t.files, tone: TYPE_TONES[i], types: [t.type], ...partsOf(t) }))
  if (rest.length) {
    const sum = key => rest.reduce((s, t) => s + partsOf(t)[key], 0)
    out.push({ type: 'other', rows: rest.reduce((s, t) => s + t.rows, 0), files: rest.reduce((s, t) => s + t.files, 0), tone: 'dim', types: rest.map(t => t.type), seen: sum('seen'), model: sum('model'), computed: sum('computed'), untouched: sum('untouched') })
  }
  return out
}

/** `cells` shared by `weights`, the leftover cells going to the largest remainders, every non-zero weight at least one
 *  cell while there are cells for each. */
export function shareCells(weights, cells) {
  const total = weights.reduce((s, x) => s + x, 0)
  if (!total || cells <= 0) return weights.map(() => 0)
  const exact = weights.map(x => (x * cells) / total)
  const out = exact.map(Math.floor)
  const order = exact.map((c, i) => ({ i, r: c - Math.floor(c) })).sort((a, b) => b.r - a.r)
  for (let k = 0, left = cells - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k % order.length].i]++
  if (weights.filter(x => x > 0).length <= cells) {
    weights.forEach((x, i) => {
      if (x <= 0 || out[i]) return
      const big = out.reduce((b, c, j) => (c > out[b] ? j : b), 0)
      out[big]--
      out[i] = 1
    })
  }
  return out
}

/** The bar as cells: each type's cells by its rows, then within them its seen, model-read, computed and untouched
 *  rows in that order (each part with rows at least one cell while there is room). [{tone, part, n}] in order: the
 *  pane's bar and the small one in thimble's bar. */
export function mixCells(mix, cells) {
  const per = shareCells(mix.map(t => t.rows), cells)
  const out = []
  mix.forEach((t, i) => {
    const c = per[i]
    if (!c) return
    const inner = shareCells(PARTS.map(p => t[p] || 0), c)
    PARTS.forEach((p, j) => { if (inner[j]) out.push({ tone: t.tone, part: p, n: inner[j] }) })
  })
  return out
}

/** The small bar in thimble's bar: each type's cells by its rows, its seen part bright (at least one cell when any was
 *  seen) and the rest pale; what was computed over is the pane's to show, not this one's. [{tone, seen, n}]. */
export function barCells(mix, cells) {
  const per = shareCells(mix.map(t => t.rows), cells)
  const out = []
  mix.forEach((t, i) => {
    const c = per[i]
    if (!c) return
    const r = t.seen > 0 ? Math.max(1, Math.min(c, Math.round((c * t.seen) / t.rows))) : 0
    if (r) out.push({ tone: t.tone, seen: true, n: r })
    if (c - r) out.push({ tone: t.tone, seen: false, n: c - r })
  })
  return out
}

/** Cells as markup: each part its glyph, untouched pale. */
export function cellsMarkup(cells) {
  return cells.map(c => `{${c.part === 'untouched' ? `${c.tone}-faint` : c.tone}:${GLYPH[c.part].repeat(c.n)}}`).join('')
}

/** The strongest status of a set of files (by_status), for ordering groups: seen first, untouched last. */
const rank = by => STATUS.findIndex(s => (by || {})[s] > 0)

/** A wildcard pattern with its `*` lit: the part of the name that stands for many files (in a bold row, bold). */
function patternText(k, p, bold = false) {
  const parts = String(p).split('*').map(x => k.escape(x))
  return bold ? `**${parts.join('{accent:\\*}')}**` : parts.join('{accent:**\\***}')
}

export default {
  name: 'coverage',
  title: 'Coverage',
  local: ['at'],
  reads: () => ['coverage'],
  stateKey: () => 'coverage',
  /** What a question asked under the pane is about, beyond the part selected (side.ts paneSubject). */
  thread(_args, _state, data) {
    const t = (data && data.total) || {}
    return { about: `what this session did with the folder's files, by \`thimble coverage\`: ${sentence(t, data && data.session)} ${n(t.computed_rows || 0)} more rows were only computed over, and ${n(t.model_rows || 0)} read by a label's model, none of them in Claude's context. A file is read (seen) when some of its lines entered Claude's context; computed over when a query or a rule label went over its rows and none of them did; searched when a shell search went over it; counted when it was only named, listed or counted; not touched otherwise` }
  },
  data(stores, _args, size) {
    const s = stores.coverage || {}
    const cov = s.cov
    if (!cov) return { loading: s.error ? null : 'reading what this session saw…', error: s.error || null, w: size.w, h: size.h }
    const files = (cov.files || []).map(f => ({ path: f.path, type: f.type || '', group: f.pattern || f.group || f.path, rows: f.rows || 0, lines: f.lines || 0, status: f.status, share: f.share || 0, seen_lines: f.seen_lines ?? f.read_lines ?? 0, computed: f.computed || 0, model: f.model || 0, labels: f.labels || [], shown: f.shown || 0, hits: f.hits || 0, by: f.by || [], searched_by: f.searched_by || [], queries: f.queries || [], ranges: f.ranges || [], hit_lines: f.hit_lines || [] }))
    const groups = (key, list) => list.map(g => ({ key: g[key], files: g.files, rows: g.rows, touched: g.touched ?? 0, seenFiles: g.seen_files ?? 0, ...partsOf(g), by: g.by_status || {} }))
      .sort((a, b) => (rank(a.by) - rank(b.by)) || (b.rows - a.rows) || String(a.key).localeCompare(String(b.key)))
    return {
      total: cov.total || {}, session: cov.session, files, mix: typeMix(cov.types), chat: !!s.chat,
      pattern: cov.patterns ? groups('pattern', cov.patterns) : groups('group', cov.groups || []), type: groups('type', cov.types || []), refreshing: !!s.loading, w: size.w, h: size.h,
    }
  },
  program,
}

export function program(k, data) {
  if (!data.files) {
    if (data.error) return k.text(`{bad:×} the coverage could not be read: ${k.escape(data.error)}`)
    return k.text(`{dim:◌ ${k.escape(data.loading || 'reading what this session saw…')}}`)
  }
  const st = k.state || {}
  const by = st.by === 'type' ? 'type' : 'pattern'
  const W = Math.max(40, k.w)
  const fileOf = p => data.files.find(f => f.path === p) || null
  const groupList = data[by]
  const group = st.group != null ? groupList.find(g => g.key === st.group) || null : null
  const file = st.file ? fileOf(st.file) : null
  const level = file ? 'file' : group ? 'group' : 'top'

  // ---- the items of this level, in order: what the ring walks
  const inGroup = g => data.files.filter(f => (by === 'type' ? f.type : f.group) === g.key)
    .sort((a, b) => STATUS.indexOf(a.status) - STATUS.indexOf(b.status) || a.path.localeCompare(b.path, 'en', { numeric: true }))
  const ranges = file ? rangesOf(file) : []
  const items = level === 'top' ? groupList.map((g, i) => ({ id: `g-${i}`, g })) : level === 'group' ? inGroup(group).map((f, i) => ({ id: `f-${i}`, f })) : ranges.map((r, i) => ({ id: `rg-${i}`, r }))
  const ids = items.map(x => x.id)
  const at = ids.includes(st.at) ? st.at : st.at === 'by-pattern' || st.at === 'by-type' || st.at === 'back' ? st.at : ids[0] || null
  const idx = ids.indexOf(at)

  // ---- what the person does
  const open = id => {
    if (id === 'by-pattern' || id === 'by-type') return { by: id.slice(3), group: null, file: null, at: id }
    const it = items.find(x => x.id === id)
    if (!it) return null
    if (it.g) return { group: it.g.key, file: null, at: 'f-0' }
    if (it.f) return { file: it.f.path, at: 'rg-0' }
    // a seen range: its lines as a citation, over this pane
    if (it.r && file) { k.do('open', { mark: { kind: 'cite', ref: rangeRef(file, it.r), label: `${file.path} ${rangeWords(it.r)}` } }); return { at: id } }
    return { at: id }
  }
  const back = () => (file ? { file: null, at: `f-${Math.max(0, inGroup(group || { key: null }).findIndex(f => f.path === file.path))}` }
    : group ? { group: null, at: `g-${Math.max(0, groupList.findIndex(g => g.key === group.key))}` } : null)
  // the ring on a part selects it; a press opens it (a group, a file, a seen range as a citation)
  k.on('focus', e => (e.region ? { at: e.region } : null))
  k.on('press', e => (e.region ? open(e.region) : null))
  k.on('return', () => (at ? open(at) : null))
  // esc goes back a level; the host draws the way back as a press that does the same
  if (level !== 'top') k.on('esc', back, level === 'file' ? String(group ? group.key : 'the files') : 'Coverage')
  if (at) k.select(at)

  const t = data.total
  const head = level === 'top' ? overview(k, data) : []
  if (level === 'top') {
    const rows = Math.max(3, k.h - head.length - 3 - chromeOf(k, data.chat))
    return k.stack(...head, k.text(' '), toggles(k, by), listOf(k, items, idx, rows, (it, on) => groupRow(k, it.g, by, W, on, it.id), header(k, by === 'type' ? 'type' : 'pattern', W)))
  }
  if (level === 'group') {
    const share = group.rows ? group.seen / group.rows : 0
    const title = subjectBlock(k, {
      title: by === 'type' ? `${k.escape(group.key)} files` : String(group.key).split('*').map(x => k.escape(x)).join('{accent:\\*}'),
      line: `Claude read ${n(Math.round(group.seen))} of their ${n(group.rows)} rows (${pct(share)}), from ${n(group.seenFiles)} of ${n(group.files)} file${group.files === 1 ? '' : 's'}.`,
    })
    const rows = Math.max(3, k.h - 4 - chromeOf(k, data.chat))
    const pw = pathW(items.map(x => x.f), group, by, W)
    return k.stack(title, k.text(' '), listOf(k, items, idx, rows, (it, on) => fileRow(k, it.f, group, by, W, pw, on, it.id), fileHeader(k, pw)))
  }
  // ---- one file
  const unit = /^(jsonl|transcript)$/.test(file.type) ? 'rows' : 'lines'
  const total = file.lines || file.rows
  const title = subjectBlock(k, { title: k.escape(file.path), line: `{dim:file · ${n(total)} ${unit} ·} {${TONE[file.status]}:${SAID[file.status]}}` })
  const out = [title, k.text(`{dim:${k.escape(fileWords(file, unit))}}`, { wrap: false }), strip(k, file, W), k.text(' ')]
  if (!ranges.length && file.status === 'model') {
    out.push(k.text(`{dim:A label's model read ${n(file.model)} of its rows (${k.escape(file.labels.join(', ') || 'a label')}); none of its lines entered Claude's context.}`))
    return k.stack(out)
  }
  if (!ranges.length && file.status === 'computed') {
    out.push(k.text(`{dim:Computed over: ${k.escape([...file.queries, ...file.labels].slice(0, 4).join(', ') || 'a query')} went over its rows, and none of them entered a context. Claude saw what came out, not the rows.}`))
    return k.stack(out)
  }
  if (!ranges.length) {
    out.push(k.text(`{dim:No line of it entered Claude's context${file.status === 'named' ? ': it was only named, listed or counted' + (file.by.length ? ` (${k.escape(file.by.join(', '))})` : '') : file.status === 'searched' ? ': a search in the shell went over it, and which lines it showed is not known' : ''}.}`))
    return k.stack(out)
  }
  const shown = Math.min(ranges.length, 4)
  out.push(listOf(k, items, idx, shown, (it, on) => rangeRow(k, it.r, on, it.id, unit, file), null))
  out.push(k.text(' '))
  const r = ranges[Math.max(0, idx)] || ranges[0]
  const room = Math.max(3, k.h - out.length - 1 - chromeOf(k, data.chat))
  const from = Math.max(1, Math.min(r.from - 2, Math.max(1, total - room + 1)))
  const to = Math.min(total || r.to, from + room - 1)
  const got = k.want({ lines: file.path, from, to })
  out.push(linesView(k, file, got, from, to, W))
  return k.stack(out)
}

/** The seen ranges of a file, to step through: each a range of lines, said as a search's when a search showed them all. */
export function rangesOf(f) {
  const hits = new Set(f.hit_lines || [])
  return (f.ranges || []).map(([a, b]) => {
    let all = b - a < 400
    for (let i = a; all && i <= b; i++) if (!hits.has(i)) all = false
    return all ? { kind: 'hit', from: a, to: b, lines: Array.from({ length: b - a + 1 }, (_, i) => a + i) } : { kind: 'read', from: a, to: b }
  })
}

/** What Claude read, in one plain sentence: its rows of all the folder's rows, and in how many of its files. */
export function sentence(t, session) {
  const who = session === null ? "Claude's sessions" : 'Claude'
  const rows = t.seen_rows ?? t.read_rows ?? 0
  const files = t.seen_files ?? t.read_files ?? 0
  return `${who} read ${n(rows)} of the folder's ${n(t.rows || 0)} rows (${pct(t.seen_share ?? t.read_share ?? 0)}), from ${n(files)} of its ${n(t.files || 0)} files.`
}

/** The legend of the groups' bars, always in view: each part's color and what it means. */
function legend(k) {
  return k.text(KEY.map(([, tone, words]) => `{${tone}:■} {dim:${words}}`).join('   '), { wrap: false })
}

/** The overview: the sentence, then the legend. */
function overview(k, data) {
  const top = subjectBlock(k, { title: 'Coverage', line: `${k.escape(sentence(data.total, data.session))}${data.refreshing ? '{dim: ◌}' : ''}` })
  return [top, legend(k)]
}

function toggles(k, by) {
  const one = (id, words, on) => k.region(id, { label: `group the files ${words}` }, k.text(on ? `{accent:**${words}**}` : `{dim:${words}}`, { wrap: false }))
  return k.beside(one('by-pattern', 'by pattern', by === 'pattern'), k.text('{dim:·}', { wrap: false }), one('by-type', 'by type', by === 'type'), { gap: 1 })
}

// a group's row: its name, its files, its rows, its bar in three parts and the share read
const BAR = 24

function nameW(W) {
  return Math.max(16, W - 3 - 6 - 15 - (BAR + 2) - 10)
}

function header(k, what, W) {
  // laid out as a row is, so its words stand over their columns
  return k.beside(k.text(`{dim:  ${pad(what, nameW(W))} ${pad('files', 5, true)} ${pad('rows', 14, true)}  }`, { wrap: false }), k.text(' '.repeat(BAR), { wrap: false, w: BAR }), k.text(`{dim: ${pad('read', 5, true)}}`, { wrap: false }))
}

function groupRow(k, g, by, W, on, id) {
  const nw = nameW(W)
  const name = by === 'type' ? (on ? `**${k.escape(cut(g.key, nw))}**` : k.escape(cut(g.key, nw))) : patternText(k, cut(g.key, nw), on)
  const len = Array.from(cut(g.key, nw)).length
  const share = g.rows ? g.seen / g.rows : 0
  const counted = (g.model || 0) + (g.computed || 0)
  const left = `${on ? '{accent:**▸**} ' : '  '}${name}${' '.repeat(Math.max(0, nw - len))} ${pad(n(g.files), 5, true)} ${pad(`${n(g.rows)} rows`, 14, true)}  `
  // its rows in the legend's three parts: a bar as a card draws one, so a selected row keeps its colors and its height
  const bar = k.bar([{ value: g.seen, tone: 'accent' }, { value: counted, tone: 'dim' }, { value: g.untouched, tone: 'dim-faint' }], { max: Math.max(1, g.rows), w: BAR })
  const row = k.beside(k.text(left, { wrap: false }), bar, k.text(` ${pad(pct(share), 5, true)}`, { wrap: false }))
  // a pattern's group carries its pattern, which `thimble rows` reads, so a question about it names its files
  return k.region(id, { label: `${g.key}: ${n(g.files)} files, ${n(g.rows)} rows; Claude read ${pct(share)} of them`, ...(by === 'pattern' ? { ref: g.key } : {}) }, row)
}

/** A file as its group's list names it: by its name alone when the group's pattern names its folder (the header says
 *  it), else by its path, cut from the left so its name stays. */
function nameIn(f, group, by) {
  const slash = String(group.key).lastIndexOf('/')
  const folder = by === 'pattern' && slash > 0 && !String(group.key).slice(0, slash).includes('*') ? String(group.key).slice(0, slash + 1) : ''
  return folder && f.path.startsWith(folder) ? f.path.slice(folder.length) : f.path
}
const leftCut = (s, k) => (Array.from(s).length <= k ? s : '…' + Array.from(s).slice(-(k - 1)).join(''))

/** The name column of a group's files: as wide as its longest name, at most 45% of the row. */
const pathW = (files, group, by, W) => Math.max(10, Math.min(Math.floor(W * 0.45), Math.max(4, ...files.map(f => Array.from(nameIn(f, group, by)).length))))

function fileHeader(k, pw) {
  return k.text(`{dim:  ${pad('', 12)}${pad('file', pw)}  ${pad('rows', 8, true)}  what Claude did with it}`, { wrap: false })
}

/** What happened to a file, in a few words, as the kernel's coverage text says it. */
export function fileWords(f, unit = 'lines') {
  const total = f.lines || f.rows
  const what = [...(f.queries || []), ...(f.labels || [])].slice(0, 3)
  const computed = f.computed ? `computed over ${f.computed >= f.rows ? 'all' : n(f.computed) + ' of'} ${n(f.rows)} rows${what.length ? ` (${what.join(', ')})` : ''}` : ''
  if (f.status === 'seen') {
    const r = (f.ranges || []).slice(0, 3).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')
    const more = (f.ranges || []).length > 3 ? ` and ${(f.ranges || []).length - 3} more` : ''
    const seen = f.seen_lines || f.shown
    return `read ${n(seen)} of ${n(total)} ${unit} (${pct(seen / Math.max(1, total))})${r ? `: ${unit} ${r}${more}` : ''}${computed ? `; ${computed}` : ''}`
  }
  if (f.status === 'model') return `a label's model read ${n(f.model)} of ${n(f.rows)} rows${f.labels.length ? ` (${f.labels.join(', ')})` : ''}; Claude read none`
  if (f.status === 'searched') return `searched${f.searched_by.length ? ` by ${f.searched_by.join(', ')}` : ''}; which lines it showed is not known`
  if (f.status === 'computed') return `${computed}; Claude read none of them`
  if (f.status === 'named') return `only named, listed or counted${f.by.length ? ` (${f.by.slice(0, 4).join(', ')})` : ''}; Claude read none of its lines`
  return 'not touched'
}

function fileRow(k, f, group, by, W, pw, on, id) {
  const shown = leftCut(nameIn(f, group, by), pw)
  const name = k.escape(shown)
  const words = fileWords(f, /^(jsonl|transcript)$/.test(f.type) ? 'rows' : 'lines')
  const line = `${on ? '{accent:**▸**} ' : '  '}{${TONE[f.status]}:${pad(SAID[f.status], 12)}}${on ? `**${name}**` : name}${' '.repeat(Math.max(0, pw - Array.from(shown).length))}  ${pad(n(f.rows), 8, true)}  {dim:${k.escape(cut(words, Math.max(10, W - pw - 24)))}}`
  return k.region(id, { label: `${f.path}: ${words}`, ref: fileRef(f) }, k.text(line, { wrap: false }))
}

/** A file as a ref: the lines that entered Claude's context, else the file. */
export function fileRef(f) {
  if ((f.ranges || []).length) return `${f.path}#L${f.ranges.slice(0, 40).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')}`
  if ((f.hit_lines || []).length) return `${f.path}#L${f.hit_lines.slice(0, 60).join(',')}`
  return f.path
}

/** A seen range, or a run of lines a search showed, as a ref. */
export function rangeRef(f, r) {
  return r.kind === 'read' ? `${f.path}#L${r.from === r.to ? r.from : `${r.from}-${r.to}`}` : `${f.path}#L${r.lines.join(',')}`
}

const rangeWords = r => (r.kind === 'read' ? (r.from === r.to ? `line ${r.from}` : `lines ${r.from}–${r.to}`) : `lines ${r.lines.join(', ')}`)

function rangeRow(k, r, on, id, unit, f) {
  const words = r.kind === 'read'
    ? `{accent:read}  ${unit} ${r.from === r.to ? n(r.from) : `${n(r.from)}–${n(r.to)}`}{dim:  (${n(r.to - r.from + 1)})}`
    : `{accent:read} {warn:as a search showed them}  ${r.lines.length === 1 ? 'line' : 'lines'} ${r.lines.map(n).join(', ')}`
  return k.region(id, { label: r.kind === 'read' ? `${f.path}: seen ${unit} ${r.from} to ${r.to}` : `${f.path}: lines a search showed, ${r.lines.join(', ')}`, ref: rangeRef(f, r) }, k.text(`${on ? '{accent:**▸**} ' : '  '}${words}`, { wrap: false }))
}

/** The whole file in one row: each cell a stretch of its lines, lit where a seen range falls (in a search's color where
 *  only a search showed it); the rest in the shade of what else went over it: read by a label's model ▓, computed over
 *  ▒, untouched ░. */
function strip(k, f, W) {
  const total = Math.max(1, f.lines || f.rows || 1)
  const w = Math.max(10, W - 2)
  const cell = new Array(w).fill('')
  const at = line => Math.min(w - 1, Math.floor(((line - 1) * w) / total))
  const hits = new Set(f.hit_lines || [])
  for (const [a, b] of f.ranges || []) for (let c = at(a); c <= at(b); c++) cell[c] = cell[c] === 'seen' || !hits.has(a) ? 'seen' : 'hit'
  // in the legend's colors: read, only counted or computed over, not touched
  const rest = f.model || f.computed ? '{dim:▆}' : '{dim-faint:▆}'
  let s = ''
  for (const c of cell) s += c === 'seen' ? '{accent:▆}' : c === 'hit' ? '{warn:▆}' : rest
  return k.text(s, { wrap: false })
}

/** The file's own lines, numbered, those seen marked ▌ (in a search's color where a search showed them), the rest dim. */
function linesView(k, f, got, from, to, W) {
  if (!got) return k.text('{dim:   reading the file…}')
  if (got.error) return k.text(`{bad:   × ${k.escape(got.error)}}`)
  const lines = Array.isArray(got.lines) ? got.lines : []
  const read = new Set()
  for (const [a, b] of f.ranges || []) for (let i = Math.max(a, from); i <= Math.min(b, to); i++) read.add(i)
  const hits = new Set(f.hit_lines || [])
  const nw = String(to).length
  return k.stack(lines.map((t, i) => {
    const no = from + i
    const text = k.escape(cut(String(t).replace(/\t/g, '  ').slice(0, LINES), W - nw - 4))
    if (hits.has(no)) return k.text(`{warn:${String(no).padStart(nw)} ▌}${text}`, { wrap: false })
    if (read.has(no)) return k.text(`{accent:${String(no).padStart(nw)} ▌}${text}`, { wrap: false })
    return k.text(`{dim:${String(no).padStart(nw)} │${text}}`, { wrap: false })
  }))
}

/** A list in `rows` rows, its header first: the window holds the selected item with a few items above and below it
 *  drawn (so the ring can step on while the next drawing is on its way, however fast the arrows come), as a pure
 *  function of the selection; a dim row above and below says how many more there are. */
export function listOf(k, items, idx, rows, row, head) {
  const out = head ? [head] : []
  const room = Math.max(3, rows - out.length)
  if (!items.length) return k.stack(...out, k.text('{dim:  nothing here}'))
  if (items.length <= room) return k.stack(...out, ...items.map((it, i) => row(it, i === idx)))
  const fit = Math.max(3, room - 2)
  const margin = Math.max(1, Math.min(3, Math.floor((fit - 1) / 4)))
  const step = Math.max(1, fit - 2 * margin)
  const s = Math.max(0, idx)
  const top = Math.max(0, Math.min(items.length - fit, Math.floor(s / step) * step - margin))
  const shown = items.slice(top, top + fit)
  const more = items.length - top - shown.length
  return k.stack(...out,
    k.text(top > 0 ? `{dim:  ↑ ${n(top)} more}` : ' ', { wrap: false }),
    ...shown.map((it, i) => row(it, top + i === idx)),
    k.text(more > 0 ? `{dim:  ↓ ${n(more)} more}` : ' ', { wrap: false }))
}
