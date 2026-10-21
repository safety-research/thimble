// coverage.js: what this session did with the folder's files, a program on the card runtime (draw/kit.js) over
// `thimble coverage --json` (engine/kernel/lineage.py coverage). It opens in the side panel (shell/side.ts openSide) as
// a thread: a question typed under it is about the group, file or lines selected, and carries their refs. The bar's
// `coverage 3/7 files` opens it (a click, or r). It says in one sentence what Claude did: how many of the folder's
// files it touched (the bar's count: some of a file entered Claude's context, or a query, a rule, a search, a count or a
// program went over it; a file only listed by name is not touched), then how much of each unit it read. Each file and
// each group has two measures, each a bar and its share in the files' own unit, which a legend under the sentence
// names, always in view:
//
//   read      what entered Claude's context
//   counted   what was counted or computed over: a query, a rule label or a label's model went over it, or Claude read
//             it (read is part of it)
//
// Overview first, then zoom, then details on demand:
//
//   overview   the sentence and the legend; then a folder of a few files (FEW, or as many as fit) lists them all, with
//              no group to open; a larger one lists its groups, by folder or by file type, those Claude touched first,
//              and the rest on one line (`8,412 other files, none touched`). ↵ or a press opens a group (or that line)
//              under itself, and closes it again (listItems)
//   a file     a strip of the whole file with the lines seen lit, the seen ranges, and the file's own lines around the
//              one selected (seen lines marked ▌, those a search showed in its color); a press on a range opens its
//              lines as a citation, over this pane (esc comes back). A PDF has a strip of its pages, and an image or
//              any other whole file only its words.
//
// Each file is counted in its own unit (kernel/lineage.py UNITS): records of a JSONL or JSON file, rows of a table,
// lines of text, pages of a PDF, and an image or any other file as one whole file.
//
//   state: {by: 'folder' | 'type', open: the groups open, file: the file open, at: the part selected}
//   presses: a group opens its files under it, a file its lines, a range its lines as a citation; `by folder` and
//            `by type` group the files. keys: none of its own: the side panel's ring walks the parts (↑ ↓, tab), starting on the
//            part selected, ↵ presses the one it is on, esc goes back from a file to the list (at the top, esc is the
//            panel's: back, or close)
//   wants: {lines: path, from, to} (the file's lines around a range, read by the host)
//   asks of the host: open {mark: {kind: 'cite', ref, label}} (a seen range, as a citation)

import { subjectBlock } from './subject.js'

const STATUS = ['seen', 'model', 'searched', 'computed', 'named', 'not read']
// each status as the pane says it, and its tone
const SAID = { seen: 'read', model: 'computed', searched: 'searched', computed: 'computed', named: 'counted', 'not read': 'none' }
const TONE = { seen: 'accent', model: 'dim', searched: 'dim', computed: 'dim', named: 'dim', 'not read': 'unseen' }
// the three parts of a group's bar and the legend's words for them: read into Claude's context, only counted or
// computed over (a label's model too), not touched
// (each with its short words, for a pane too narrow for the long ones)
export const KEY = [['read', 'accent', "read into Claude's context", "read into Claude's context"], ['counted', 'dim', 'counted or computed over (read is part of it)', 'counted or computed over']]
// the shades of a file's rows: seen, read by a label's model, computed over, untouched
export const PARTS = ['seen', 'model', 'computed', 'untouched']
export const GLYPH = { seen: '█', model: '▓', computed: '▒', untouched: '░' }
// the file types the bar names by color; the others are `other`
const TYPE_TONES = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
const LINES = 400 // characters of one line of a file shown
// the rows the side panel takes under a pane: its input bar, and its thread's conversation when it has one (up to
// two fifths of the panel), so a list that fits shows whole above them, the overview in view
const chromeOf = (k, chat) => 5 + (chat ? Math.floor(k.h * 0.4) : 0)
const n = x => (typeof x === 'number' ? Math.round(x).toLocaleString('en-US') : String(x))
// a unit's word for one of it (kernel/lineage.py ONE)
const ONE = { records: 'record', rows: 'row', lines: 'line', pages: 'page', file: 'file' }
/** A file's unit: the kernel's, else by its type as earlier kernels counted it. */
const unitOf = f => f.unit || (/^(jsonl|transcript)$/.test(f.type) ? 'records' : 'lines')
const cut = (s, k) => (Array.from(String(s)).length <= k ? String(s) : Array.from(String(s)).slice(0, Math.max(0, k - 1)).join('') + '…')
const pad = (s, k, right = false) => { const t = cut(s, k); const sp = ' '.repeat(Math.max(0, k - Array.from(t).length)); return right ? sp + t : t + sp }

/** A file's folder (kernel/lineage.py folder_of): `runs/r004/`, or `./` for the top folder. */
export const folderOf = p => (String(p).includes('/') ? String(p).slice(0, String(p).lastIndexOf('/') + 1) : './')
/** A file's type (kernel/lineage.py type_of): its extension, else `no extension`. */
export function typeOfPath(p) {
  const name = String(p).slice(String(p).lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'no extension'
}
// a folder of at most this many files shows them all, with no group to open (or as many as the pane has rows for)
export const FEW = 12

/** What the list shows, in order, as the default expands it: a folder of a few files (FEW, or as many as fit `room`)
 *  its files, with no group to open; a larger one its groups (by folder or by type) that Claude touched, first, each
 *  with its files under it when open, then one line for the groups nothing touched (`8,412 other files, none touched`),
 *  which opens to them. `open`: the keys of the groups open (`rest` for that line). Each item {id, kind: 'file' |
 *  'group' | 'rest', f | g, depth, files}. */
/** The id of a file's (`f`) or a group's (`g`) row. A region's id holds letters, digits and `_.:-`, at most 64 of
 *  them (draw/kit.js), and the kit renames any other: then the part the program selects and the part the person moves
 *  to are two names, and a press or a move finds no row. A path with other characters (`runs/r01/x.txt`) is spelled
 *  with them as `-` and made unique by a short hash of the whole path: `f:runs-r01-x.txt.k3x9a`. */
export function itemId(kind, path) {
  const raw = `${kind}:${path}`
  if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(raw)) return raw
  let h = 0
  for (const ch of String(path)) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0
  return `${kind}:${String(path).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 40)}.${h.toString(36)}`
}

export function listItems(data, by, open, room = FEW) {
  const files = data.files || []
  const rest = data.rest || { path: [] }
  const order = (a, b) => STATUS.indexOf(a.status) - STATUS.indexOf(b.status) || a.path.localeCompare(b.path, 'en', { numeric: true })
  const all = () => [...files, ...rest.path.map((_, i) => restFile(rest, i))]
  if (files.length + rest.path.length <= Math.max(FEW, room)) return all().sort(order).map(f => ({ id: itemId('f', f.path), kind: 'file', f, depth: 0 }))
  const isOpen = new Set(open || [])
  const keyOf = by === 'type' ? f => f.type : f => f.folder
  const out = []
  const group = (g, depth) => {
    out.push({ id: itemId('g', g.key), kind: 'group', g, depth })
    if (!isOpen.has(g.key)) return
    // its files, read once a group is open
    const mine = files.filter(f => keyOf(f) === g.key)
    for (let i = 0; i < rest.path.length; i++) if ((by === 'type' ? typeOfPath(rest.path[i]) : folderOf(rest.path[i])) === g.key) mine.push(restFile(rest, i))
    for (const f of mine.sort(order)) out.push({ id: itemId('f', f.path), kind: 'file', f, depth: depth + 1 })
  }
  const list = data[by] || []
  const touched = list.filter(g => g.touched > 0)
  const others = list.filter(g => !(g.touched > 0))
  touched.forEach(g => group(g, 0))
  if (others.length) {
    out.push({ id: 'rest', kind: 'rest', depth: 0, groups: others.length, files: others.reduce((s, g) => s + g.files, 0), any: touched.length > 0 })
    if (isOpen.has('rest')) others.forEach(g => group(g, 1))
  }
  return out
}

/** A file nothing touched, from the record's columns, as a row of the list. */
function restFile(rest, i) {
  const p = rest.path[i], unit = rest.unit[i], units = rest.units[i]
  return { path: p, type: typeOfPath(p), folder: folderOf(p), unit, units, rows: units, lines: unit === 'lines' ? units : 0, status: 'not read', said: 'none', touched: false, read: 0, counted: 0, ranges: [], hit_lines: [], pages: [], by: [], searched_by: [], queries: [], labels: [] }
}

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

/** Part of a total in a unit, as `thimble coverage` says it (kernel/lineage.py amount): `3 of 14,591 records (0.02%)`;
 *  whole files have no share (`1 of 2 files`, or `other files` beside other units). */
export function amount(unit, part, total, other = false) {
  if (unit === 'file') return `${n(part)} of ${n(total)} ${other ? 'other ' : ''}${total === 1 ? 'file' : 'files'}`
  return `${n(part)} of ${n(total)} ${total === 1 ? ONE[unit] || unit : unit} (${pct(total ? part / total : 0)})`
}

/** Each unit's part, joined (kernel/lineage.py amounts): `7 of 42,205 records (0.01%) and 2 of 12 pages (16%)`. */
export function amounts(units, key = 'seen') {
  const list = units || []
  const bits = list.filter(u => key === 'seen' || u[key]).map(u => amount(u.unit, u[key] || 0, u.units || 0, list.length > 1))
  return bits.length <= 1 ? bits[0] || '' : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`
}

/** A set of files' size in its unit, for a group's row: `14,591 records`, `12 pages`, `3 files`. */
export function sizeOf(units) {
  const list = units || []
  return list.map(u => `${n(u.units)} ${u.unit === 'file' ? (u.units === 1 ? 'file' : 'files') : u.units === 1 ? ONE[u.unit] : u.unit}`).join(', ')
}

/** A group's rows in the four shades, apart: seen, read by a label's model, computed over, untouched. */
export function partsOf(g) {
  const rows = Math.max(0, g.rows || 0)
  const seen = Math.min(rows, g.seen_rows ?? g.read_rows ?? 0)
  const model = Math.min(rows - seen, g.model_rows || 0)
  const computed = Math.min(rows - seen - model, g.computed_rows || 0)
  return { seen, model, computed, untouched: Math.max(0, rows - seen - model - computed) }
}

/** The file types as the bar draws them: the largest by rows, each with its tone, its files, those read and those
 *  touched, and its rows in the four shades; past six, one `other`. Each {type, rows, files, seenFiles, touchedFiles,
 *  tone, types, seen, model, computed, untouched}. */
export function typeMix(types) {
  const all = (types || []).filter(t => t && t.files > 0)
  const named = all.slice(0, all.length > TYPE_TONES.length ? TYPE_TONES.length - 1 : TYPE_TONES.length)
  const rest = all.slice(named.length)
  const out = named.map((t, i) => ({ type: t.type, rows: t.rows, files: t.files, seenFiles: t.seen_files || 0, touchedFiles: t.touched || 0, tone: TYPE_TONES[i], types: [t.type], ...partsOf(t) }))
  if (rest.length) {
    const sum = key => rest.reduce((s, t) => s + partsOf(t)[key], 0)
    out.push({ type: 'other', rows: rest.reduce((s, t) => s + t.rows, 0), files: rest.reduce((s, t) => s + t.files, 0), seenFiles: rest.reduce((s, t) => s + (t.seen_files || 0), 0), touchedFiles: rest.reduce((s, t) => s + (t.touched || 0), 0), tone: 'dim', types: rest.map(t => t.type), seen: sum('seen'), model: sum('model'), computed: sum('computed'), untouched: sum('untouched') })
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
 *  rows in that order (each part with rows at least one cell while there is room). [{tone, part, n}] in order. */
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

/** The small bar in thimble's bar, filled from the left by the share of files touched, as its number is: the files
 *  touched first (at least one cell when any was, and one pale cell left while any was not), then the files not touched,
 *  pale; each part shared among the file types by their files, in the types' colors. How much of each file is the
 *  pane's to show, not this one's. [{tone, seen, n}] (seen: lit). */
export function barCells(mix, cells) {
  const files = mix.reduce((s, t) => s + t.files, 0)
  const hit = t => t.touchedFiles ?? t.seenFiles ?? 0
  const touched = mix.reduce((s, t) => s + hit(t), 0)
  if (!files || cells <= 0) return []
  let lit = Math.round((cells * touched) / files)
  if (touched > 0) lit = Math.max(1, lit)
  if (touched < files) lit = Math.min(cells - 1, lit)
  const on = shareCells(mix.map(hit), lit)
  const off = shareCells(mix.map(t => t.files - hit(t)), cells - lit)
  return [...mix.map((t, i) => ({ tone: t.tone, seen: true, n: on[i] })), ...mix.map((t, i) => ({ tone: t.tone, seen: false, n: off[i] }))].filter(c => c.n > 0)
}

/** Cells as markup: each part its glyph, untouched pale. */
export function cellsMarkup(cells) {
  return cells.map(c => `{${c.part === 'untouched' ? `${c.tone}-faint` : c.tone}:${GLYPH[c.part].repeat(c.n)}}`).join('')
}


export default {
  name: 'coverage',
  title: 'Coverage',
  // the ring starts on the selected group, so ↵ opens it at once, as a click does; a letter still starts a question
  ringStart: 'part',
  local: ['at'],
  reads: () => ['coverage'],
  stateKey: () => 'coverage',
  /** What a question asked under the pane is about, beyond the part selected (side.ts paneSubject). */
  thread(_args, _state, data) {
    const t = (data && data.total) || {}
    const computed = t.units ? amounts(t.units, 'computed') : t.computed_rows ? `${n(t.computed_rows)} rows` : ''
    const model = t.units ? amounts(t.units, 'model') : t.model_rows ? `${n(t.model_rows)} rows` : ''
    const more = [computed && `only computed over: ${computed}`, model && `read by a label's model: ${model}`].filter(Boolean)
    return { about: `what this session did with the folder's files, by \`thimble coverage\`: ${sentence(t, data && data.session)}${more.length ? ` ${more.join('; ')}; none of it in Claude's context.` : ''} Each file is counted in its own unit: records, rows, lines, pages, or a whole file (an image). A file is read when some of it entered Claude's context; computed over when a query or a rule label went over its rows and none of them did; searched when a shell search went over it; counted when it was only named, listed or counted; none otherwise` }
  },
  data(stores, _args, size) {
    const s = stores.coverage || {}
    const cov = s.cov
    if (!cov) return { loading: s.error ? null : 'reading what this session saw…', error: s.error || null, w: size.w, h: size.h }
    const files = (cov.files || []).map(f => ({ path: f.path, type: f.type || typeOfPath(f.path), folder: f.folder || folderOf(f.path), kind: f.kind || '', unit: f.unit || null, units: f.units ?? null, seen_units: f.seen_units ?? null, said: f.said || null, pages: f.pages || [], rows: f.rows || 0, lines: f.lines || 0, status: f.status, share: f.share || 0, seen_lines: f.seen_lines ?? f.read_lines ?? 0, computed: f.computed || 0, model: f.model || 0, labels: f.labels || [], model_labels: f.model_labels || [], shown: f.shown || 0, hits: f.hits || 0, by: f.by || [], searched_by: f.searched_by || [], queries: f.queries || [], ranges: f.ranges || [], hit_lines: f.hit_lines || [], touched: f.touched ?? f.status !== 'not read', read: f.read_share ?? (f.status === 'seen' ? f.share || 0 : 0), counted: f.counted_share ?? Math.max(f.read_share ?? 0, f.status === 'seen' ? f.share || 0 : 0) }))
    // the files nothing touched stay in columns (cli.py cmd_coverage: their path, unit and size), made into rows only
    // when a list shows them (restFile), so a folder of 100,000 files draws quickly
    const rest = cov.untouched && Array.isArray(cov.untouched.path) ? cov.untouched : { path: [], unit: [], units: [] }
    const groups = (key, list) => list.map(g => ({ key: g[key] ?? g.group ?? g.pattern, files: g.files, rows: g.rows, units: g.units || null, touched: g.touched ?? 0, seenFiles: g.seen_files ?? 0, ...partsOf(g), by: g.by_status || {},
      read: g.read_share ?? (g.rows ? (g.seen_rows ?? 0) / g.rows : 0), counted: g.counted_share ?? (g.rows ? Math.min(1, ((g.seen_rows ?? 0) + (g.model_rows || 0) + (g.computed_rows || 0)) / g.rows) : 0) }))
      .sort((a, b) => (b.touched > 0) - (a.touched > 0) || b.read - a.read || b.counted - a.counted || b.touched - a.touched || String(a.key).localeCompare(String(b.key), 'en', { numeric: true }))
    return {
      total: cov.total || {}, session: cov.session, files, rest, mix: typeMix(cov.types), chat: !!s.chat,
      folder: groups('folder', cov.groups || cov.patterns || []), type: groups('type', cov.types || []), refreshing: !!s.loading, w: size.w, h: size.h,
    }
  },
  program,
}

/** The part a file's own view names the file by: its title. */
const WHOLE = 'file'

export function program(k, data) {
  if (!data.files) {
    if (data.error) return k.text(`{bad:×} the coverage could not be read: ${k.escape(data.error)}`)
    return k.text(`{dim:◌ ${k.escape(data.loading || 'reading what this session saw…')}}`)
  }
  const st = k.state || {}
  const by = st.by === 'type' ? 'type' : 'folder'
  const W = Math.max(40, k.w)
  const restAt = st.file && data.rest ? data.rest.path.indexOf(st.file) : -1
  const file = st.file ? data.files.find(f => f.path === st.file) || (restAt >= 0 ? restFile(data.rest, restAt) : null) : null
  const level = file ? 'file' : 'top'
  const open = Array.isArray(st.open) ? st.open : []

  // ---- the items of this level, in order: what the ring walks
  const head = level === 'top' ? overview(k, data) : []
  const room = Math.max(3, k.h - head.length - 4 - chromeOf(k, data.chat))
  const ranges = file ? rangesOf(file) : []
  const items = level === 'top' ? listItems(data, by, open, room) : ranges.map((r, i) => ({ id: `rg-${i}`, r }))
  const ids = items.map(x => x.id)
  // a file open is a part itself (its title): what the ring stands on and a question is about when none of its lines
  // was read, or when the ring goes up to it from its ranges
  const at = ids.includes(st.at) ? st.at : st.at === 'by-folder' || st.at === 'by-type' ? st.at : file && (st.at === WHOLE || !ids.length) ? WHOLE : ids[0] || null
  const idx = ids.indexOf(at)

  // ---- what the person does: a group or the line of the others opens under itself (and closes again), a file opens
  // its lines, a seen range opens as a citation
  const press = id => {
    if (id === 'by-folder' || id === 'by-type') return { by: id.slice(3), open: [], file: null, at: id }
    const it = items.find(x => x.id === id)
    if (!it) return null
    if (it.kind === 'group' || it.kind === 'rest') {
      const key = it.kind === 'rest' ? 'rest' : it.g.key
      return { open: open.includes(key) ? open.filter(x => x !== key) : [...open, key], at: id }
    }
    if (it.kind === 'file') return { file: it.f.path, at: 'rg-0', from: id }
    if (it.r && file) { k.do('open', { mark: { kind: 'cite', ref: rangeRef(file, it.r), label: `${file.path} ${rangeWords(it.r)}` } }); return { at: id } }
    return { at: id }
  }
  k.on('focus', e => (e.region ? { at: e.region } : null))
  k.on('press', e => (e.region ? press(e.region) : null))
  k.on('return', () => (at ? press(at) : null))
  // esc goes back from a file to the list, on the file
  const back = () => ({ file: null, at: st.from || itemId('f', file.path) })
  if (level === 'file') k.on('esc', back, 'Coverage')
  // ← → as in a tree: → opens the group or the file selected; ← closes the group, goes up to the group a file is in, or
  // back from a file to the list
  const groupKey = it => (it && it.kind === 'rest' ? 'rest' : it && it.kind === 'group' ? it.g.key : null)
  k.on('right', () => {
    const it = items[idx]
    return it && (it.kind === 'file' || (groupKey(it) != null && !open.includes(groupKey(it)))) ? press(it.id) : null
  })
  k.on('left', () => {
    if (level === 'file') return back()
    const it = items[idx]
    if (!it) return null
    if (groupKey(it) != null && open.includes(groupKey(it))) return { open: open.filter(x => x !== groupKey(it)), at: it.id }
    for (let j = idx - 1; j >= 0; j--) if ((items[j].depth || 0) < (it.depth || 0)) return { at: items[j].id }
    return null
  })
  if (at) k.select(at)

  if (level === 'top') {
    const many = items.some(x => x.kind !== 'file')
    const cols = columns(k.w, items, many)
    return k.stack(...head, k.text(' '), many ? toggles(k, by) : false, listOf(k, items, idx, room, (it, on) => itemRow(k, it, by, cols, on), header(k, many ? by : 'file', cols)))
  }
  // ---- one file, in its own unit: an image or another whole file has only its words, a PDF a strip of its pages
  const unit = unitOf(file)
  const named = block => k.region(WHOLE, { label: `${file.path}: ${fileWords(file)}`, ref: fileRef(file) }, block)
  if (unit === 'file') {
    const what = file.kind && file.kind !== 'file' ? file.kind : file.type
    return k.stack(named(subjectBlock(k, { title: k.escape(file.path), line: `{dim:file · ${k.escape(what)}}` })), k.text(wordsMarkup(k, file), { wrap: false }))
  }
  // the file's own lines, where its ranges and the lines shown stand (a CSV's header is line 1); its size is in its unit,
  // as the list says it (a CSV of 891 rows has 892 lines)
  const total = unit === 'pages' ? file.units || file.rows : file.lines || file.rows
  // (what happened to it is the next line's to say: `read 2 of 3,104 records (0.06%)`)
  const title = named(subjectBlock(k, { title: k.escape(file.path), line: `{dim:file · ${fileSize(file)}}` }))
  if (unit === 'pages') return k.stack(title, k.text(`{dim:${k.escape(fileWords(file))}}`, { wrap: false }), strip(k, { ...file, lines: total, ranges: file.pages, hit_lines: [] }, W))
  const out = [title, k.text(`{dim:${k.escape(fileWords(file))}}`, { wrap: false }), strip(k, file, W), k.text(' ')]
  if (!ranges.length && file.status === 'model') {
    out.push(k.text(`{dim:A label's model read ${n(file.model)} of its rows (${k.escape(file.model_labels.join(', ') || 'a label')}); none of its lines entered Claude's context.}`))
    return k.stack(out)
  }
  if (!ranges.length && file.status === 'computed') {
    out.push(k.text(`{dim:Computed over: ${k.escape([...file.queries, ...file.labels.filter(l => !file.model_labels.includes(l))].slice(0, 4).join(', ') || 'a query')} went over its rows, and none of them entered a context. Claude saw what came out, not the rows.}`))
    return k.stack(out)
  }
  if (!ranges.length) {
    out.push(k.text(`{dim:No line of it entered Claude's context${file.status === 'named' ? ': it was only named, listed or counted' + (file.by.length ? ` (${k.escape(file.by.join(', '))})` : '') : file.status === 'searched' ? ': a search in the shell went over it, and which lines it showed is not known' : ''}.}`))
    return k.stack(out)
  }
  const shown = Math.min(ranges.length, 4)
  out.push(listOf(k, items, idx, shown, (it, on) => rangeRow(k, it.r, on, it.id, 'lines', file), null))
  out.push(k.text(' '))
  const r = ranges[Math.max(0, idx)] || ranges[0]
  const space = Math.max(3, k.h - out.length - 1 - chromeOf(k, data.chat))
  const from = Math.max(1, Math.min(r.from - 2, Math.max(1, total - space + 1)))
  const to = Math.min(total || r.to, from + space - 1)
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

/** What Claude did, in one plain sentence: the files touched, as the bar says them (read, searched, counted or
 *  computed over), then the part of each unit it read some of: `Claude touched 3 of the folder's 4 files and read 7 of
 *  42,205 records (0.01%).`; whole files alone have no parts. */
export function sentence(t, session) {
  const who = session === null ? "Claude's sessions" : 'Claude'
  const touched = t.touched_files ?? t.seen_files ?? 0
  const all = t.files || 0
  const head = `${who} touched ${n(touched)} of the folder's ${n(all)} file${all === 1 ? '' : 's'}`
  // (whole files alone add nothing to the files touched)
  const units = (t.units || []).filter(u => u.seen > 0)
  const said = units.length === 1 && units[0].unit === 'file' ? '' : amounts(units)
  if (said) return `${head} and read ${said}.`
  return touched && !(t.seen_files > 0) ? `${head} and read none of their lines into its context.` : `${head}.`
}

/** A group's line under its name: what Claude read of its files, in their unit. */
export function groupLine(g) {
  const units = g.units
  const of = `${n(g.seenFiles)} of ${n(g.files)} file${g.files === 1 ? '' : 's'}`
  if (!units) return `Claude read ${n(Math.round(g.seen))} of their ${n(g.rows)} rows (${pct(g.rows ? g.seen / g.rows : 0)}), from ${of}.`
  if (units.length === 1 && units[0].unit === 'file') return `Claude saw ${of}.`
  return `Claude read ${amounts(units)}, from ${of}.`
}

/** The legend of the groups' bars, always in view: each part's color and what it means, on one row where both fit,
 *  else one row each, in their short words where the long ones do not fit. */
function legend(k) {
  const len = s => Array.from(s).length + 2
  if (KEY.reduce((s, [, , words]) => s + len(words), 0) + 3 * (KEY.length - 1) <= k.w) return k.text(KEY.map(([, tone, words]) => `{${tone}:■} {dim:${k.escape(words)}}`).join('   '), { wrap: false })
  return k.stack(...KEY.map(([, tone, words, short]) => k.text(`{${tone}:■} {dim:${k.escape(len(words) <= k.w ? words : short)}}`, { wrap: false })))
}

/** Plain words in rows of at most `w` characters, broken at spaces. */
export function wrapWords(s, w) {
  const out = ['']
  for (const word of String(s).split(' ')) {
    const last = out[out.length - 1]
    if (last && Array.from(last).length + 1 + Array.from(word).length > w) out.push(word)
    else out[out.length - 1] = last ? `${last} ${word}` : word
  }
  return out
}

/** A subject block whose dim line wraps to the panel's width (a sentence of several units is long). */
function wrappedSubject(k, title, words, tail = '') {
  const [first, ...rest] = wrapWords(words, Math.max(20, k.w - 3))
  const rows = rest.map((t, i) => k.text(`{dim:${k.escape(t)}}${i === rest.length - 1 ? tail : ''}`, { wrap: false }))
  return subjectBlock(k, { title, line: `{dim:${k.escape(first)}}${rest.length ? '' : tail}`, rows })
}

/** The overview: the sentence, then the legend. */
function overview(k, data) {
  return [wrappedSubject(k, 'Coverage', sentence(data.total, data.session), data.refreshing ? '{dim: ◌}' : ''), legend(k)]
}

function toggles(k, by) {
  const one = (id, words, on) => k.region(id, { label: `group the files ${words}` }, k.text(on ? `{accent:**${words}**}` : `{dim:${words}}`, { wrap: false }))
  return k.beside(one('by-folder', 'by folder', by === 'folder'), k.text('{dim:·}', { wrap: false }), one('by-type', 'by type', by === 'type'), { gap: 1 })
}

// each row's two measures: a bar and its share, read into Claude's context and counted or computed over. A share
// stands right-aligned in SHARE cells (`<0.01%` is six), so it is never cut
const BAR = 10
const SHARE = 7

const itemSize = it => (it.kind === 'group' ? sizeText(it.g) : it.kind === 'file' ? fileSize(it.f) : '')
// a size's number alone (`14,591`), for a pane too narrow for its unit's word
const itemNum = it => itemSize(it).split(' ')[0] || ''
const itemName = it => (it.kind === 'group' ? String(it.g.key) : it.kind === 'file' ? (it.depth ? it.f.path.slice(it.f.folder === './' ? 0 : it.f.folder.length) : it.f.path) : '')
// a group of one unit says its size in it; a group of mixed units has its files' count alone
const sizeText = g => (g.units ? (g.units.length === 1 ? sizeOf(g.units) : '') : `${n(g.rows)} rows`)
const fileSize = f => { const u = unitOf(f); const k = f.units ?? (u === 'lines' ? f.lines : f.rows); return u === 'file' ? '' : `${n(k)} ${k === 1 ? ONE[u] || u : u}` }

/** The list's columns at the pane's width `W`: the name, the files' count (a list with groups), the size, and the two
 *  measures, each a bar and its share. A number is never cut: where the row does not fit, the bars narrow first, then
 *  the size says its number alone, then the bars go, then the size (a file's own view says it); the name takes the
 *  rest, and is cut last. {nw, fw, sw, size: 'full' | 'num' | 'none', bar}. */
export function columns(W, items, many) {
  const len = s => Array.from(String(s)).length
  const fw = many ? Math.max(5, ...items.map(it => (it.kind === 'group' ? len(n(it.g.files)) : 0))) : 0
  const full = Math.max(4, ...items.map(it => len(itemSize(it))))
  const num = Math.max(4, ...items.map(it => len(itemNum(it))))
  // the name wants its whole width, up to 16 characters (a longer one is cut at its start, its end kept)
  const want = Math.min(16, Math.max(4, ...items.map(it => len(itemName(it)) + 2 * (it.depth || 0))))
  const tries = [[BAR, 'full'], [6, 'full'], [4, 'full'], [6, 'num'], [4, 'num'], [0, 'num'], [0, 'none']]
  let out = null
  for (const [bar, size] of tries) {
    const sw = size === 'full' ? full : size === 'num' ? num : 0
    const nw = W - 1 - (fw ? fw + 1 : 0) - sw - 2 * (1 + bar + SHARE)
    out = { nw: Math.max(4, nw), fw, sw, size, bar }
    if (nw >= want) break
  }
  return out
}

/** A share's column: right-aligned, after its bar when there is one. */
const shareCol = s => pad(s, SHARE, true)

function header(k, what, c) {
  // laid out as a row is, so its words stand over their columns: a measure's word over its bar, or over its share
  // when it has no bar
  const head = w => ` ${c.bar ? pad(w, c.bar + SHARE) : shareCol(w)}`
  return k.text(`{dim:${pad(what, c.nw)} ${c.fw ? `${pad(what === 'file' ? '' : 'files', c.fw, true)} ` : ''}${c.sw ? pad('size', c.sw, true) : ''}${head('read')}${head('counted')}}`, { wrap: false })
}

/** The two measures, each a space, a bar (while the pane has room for it) and its share: read (the accent) and counted
 *  or computed over (dim), each of the row's whole in its unit. */
function measures(k, read, counted, c) {
  const one = (v, tone) => [k.text(' ', { wrap: false }), ...(c.bar ? [k.bar([{ value: v, tone }, { value: 1 - v, tone: 'dim-faint' }], { max: 1, w: c.bar })] : []), k.text(shareCol(pct(v)), { wrap: false })]
  return [...one(read, 'accent'), ...one(counted, 'dim')]
}

/** A row of the list. Its press is its name and size, not its bars: the ring and the pointer mark a press by turning
 *  it inverse, which would leave a bar a thin line on a block of the text's color. */
function itemRow(k, it, by, c, on) {
  const nw = c.nw
  const ind = '  '.repeat(it.depth || 0)
  // (the side panel's gutter marks the row selected, ▸, where the ring stands on it)
  const mark = ''
  const size = s => (c.size === 'full' ? pad(s, c.sw, true) : c.size === 'num' ? pad(String(s).split(' ')[0] || '', c.sw, true) : '')
  if (it.kind === 'rest') {
    const words = `${n(it.files)} ${it.any ? 'other ' : ''}file${it.files === 1 ? '' : 's'}, none touched`
    return k.region(it.id, { label: `${words} (${n(it.groups)} ${by === 'type' ? 'types' : 'folders'})` }, k.text(`${mark}{dim:${k.escape(words)} · ${n(it.groups)} ${by === 'type' ? (it.groups === 1 ? 'type' : 'types') : it.groups === 1 ? 'folder' : 'folders'}}`, { wrap: false }))
  }
  if (it.kind === 'group') {
    const g = it.g
    const key = cut(by === 'type' ? `${g.key} files` : g.key, nw - ind.length)
    const name = on ? `**${k.escape(key)}**` : k.escape(key)
    const left = `${mark}${ind}${name}${' '.repeat(Math.max(0, nw - ind.length - Array.from(key).length))} ${c.fw ? `${pad(n(g.files), c.fw, true)} ` : ''}${size(sizeText(g))}`
    return k.beside(k.region(it.id, { label: `${g.key}: ${[`${n(g.files)} file${g.files === 1 ? '' : 's'}`, sizeText(g)].filter(Boolean).join(', ')}; Claude read ${pct(g.read)} and counted or computed over ${pct(g.counted)} of them`, ...(by === 'folder' && g.key !== './' ? { ref: `${g.key}*` } : {}) },
      k.text(left, { wrap: false })), ...measures(k, g.read, g.counted, c), { gap: 0 })
  }
  const f = it.f
  const shown = leftCut(ind + itemName(it), nw)
  const name = on ? `**${k.escape(shown)}**` : k.escape(shown)
  const left = `${mark}${name}${' '.repeat(Math.max(0, nw - Array.from(shown).length))} ${c.fw ? `${pad('', c.fw)} ` : ''}${size(fileSize(f))}`
  return k.beside(k.region(it.id, { label: `${f.path}: ${fileWords(f)}`, ref: fileRef(f) }, k.text(left, { wrap: false })), ...measures(k, f.read || 0, f.counted || 0, c), { gap: 0 })
}

const leftCut = (s, k) => (Array.from(s).length <= k ? s : '…' + Array.from(s).slice(-(k - 1)).join(''))

/** What happened to a file, in its own unit and never which rows: the kernel's words (`said`, as `thimble coverage`
 *  prints them), such as `read 3 of 14,591 records (0.02%)`, `seen` (an image) or `none`. */
export function fileWords(f) {
  if (f.said) return f.said
  if (f.status === 'seen') {
    const unit = unitOf(f)
    return `read ${amount(unit, f.seen_units ?? f.seen_lines ?? 0, f.units ?? (f.lines || f.rows))}`
  }
  return f.status === 'not read' ? 'none' : SAID[f.status] || ''
}

/** A file's words as the list shows them: its first word in the tone of what happened (read, none, computed…), the
 *  rest dim, cut to `w` characters. */
function wordsMarkup(k, f, w = 400) {
  const words = cut(fileWords(f), w)
  const at = words.search(/[ ;]/)
  const head = at < 0 ? words : words.slice(0, at)
  return `{${TONE[f.status]}:${k.escape(head)}}{dim:${k.escape(at < 0 ? '' : words.slice(at))}}`
}

/** A file as a ref: the lines that entered Claude's context, else the file (a PDF's pages and a whole file are the
 *  file). */
export function fileRef(f) {
  if (f.unit === 'pages' || f.unit === 'file') return f.path
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
  // in plain words: `line 818`, `lines 816–830 · 15 lines`, `lines 3, 7 · as a search showed them` (the line above
  // the strip says how much was read)
  const words = r.kind === 'read'
    ? (r.from === r.to ? `line ${n(r.from)}` : `lines ${n(r.from)}–${n(r.to)}{dim: · ${n(r.to - r.from + 1)} lines}`)
    : `${r.lines.length === 1 ? 'line' : 'lines'} ${r.lines.map(n).join(', ')}{dim: ·} {warn:as a search showed them}`
  return k.region(id, { label: r.kind === 'read' ? `${f.path}: seen ${unit} ${r.from} to ${r.to}` : `${f.path}: lines a search showed, ${r.lines.join(', ')}`, ref: rangeRef(f, r) }, k.text(words, { wrap: false }))
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
