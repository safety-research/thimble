// coverage.js: what Claude read of the folder, a program on the card runtime (draw/kit.js) over `thimble coverage
// --json` (engine/kernel/lineage.py coverage). It opens in the side panel (shell/side.ts openSide) as a thread: a
// question typed under it is about the group, file or lines selected, and carries their refs. The bar's `coverage 34%`
// opens it (a click, or r). Overview first, then zoom, then details on demand:
//
//   overview   a bar of the folder's rows by file type, as GitHub shows a repository's languages, each type's read part
//              bright and the rest pale; then the files grouped by wildcard pattern (`runs/*.jsonl`, the `*` lit, so it
//              is clear which files a row stands for), or by file type (t), each group with its files read, searched,
//              only counted and untouched, and the share of its rows read
//   a group    its files, each with what reached Claude: the lines read, the lines a search showed, or why none did
//   a file     a strip of the whole file with the lines read lit, the read ranges and search hits to step through, and
//              the file's own lines around the one chosen (read lines marked ▌); ↵ on a range opens its lines as a
//              citation, over this pane (esc comes back)
//
//   state: {by: 'pattern' | 'type', group: the group open, file: the file open, at: the part selected, range: the range}
//   keys: t by type / by pattern · [ ] step · 0 back · esc back (at the top, esc is the panel's: back, or close)
//   wants: {lines: path, from, to} (the file's lines around a range, read by the host)
//   asks of the host: open {mark: {kind: 'cite', ref, label}} (a read range or the search hits, as a citation)

const STATUS = ['computed', 'read', 'searched', 'named', 'not read']
// each status as the pane says it, and its tone
const SAID = { computed: 'read', read: 'read', searched: 'searched', named: 'counted', 'not read': 'untouched' }
const TONE = { computed: 'accent', read: 'accent', searched: 'warn', named: 'dim', 'not read': 'unseen' }
// the file types the bar names by color; the others are `other`
const TYPE_TONES = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
const LINES = 400 // characters of one line of a file shown
// the rows the side panel takes under a pane (its input bar), so a list that fits shows whole above it
const CHROME = 5
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

/** The file types as the bar draws them: the largest by rows, each with its tone; past six (or any with no rows), one
 *  `other`. Each {type, rows, read, files, tone, types}. */
export function typeMix(types) {
  const all = (types || []).filter(t => t && t.rows > 0)
  const named = all.slice(0, all.length > TYPE_TONES.length ? TYPE_TONES.length - 1 : TYPE_TONES.length)
  const rest = all.slice(named.length)
  const out = named.map((t, i) => ({ type: t.type, rows: t.rows, read: Math.min(t.rows, t.read_rows || 0), files: t.files, tone: TYPE_TONES[i], types: [t.type] }))
  if (rest.length) out.push({ type: 'other', rows: rest.reduce((s, t) => s + t.rows, 0), read: rest.reduce((s, t) => s + Math.min(t.rows, t.read_rows || 0), 0), files: rest.reduce((s, t) => s + t.files, 0), tone: 'dim', types: rest.map(t => t.type) })
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

/** The bar as cells: each type's cells by its rows, its read part first and bright (at least one cell when any of it
 *  was read), the rest pale. [{tone, read, n}] in order: the pane's bar and the small one in thimble's bar. */
export function mixCells(mix, cells) {
  const per = shareCells(mix.map(t => t.rows), cells)
  const out = []
  mix.forEach((t, i) => {
    const c = per[i]
    if (!c) return
    const r = t.read > 0 ? Math.max(1, Math.min(c, Math.round((c * t.read) / t.rows))) : 0
    if (r) out.push({ tone: t.tone, read: true, n: r })
    if (c - r) out.push({ tone: t.tone, read: false, n: c - r })
  })
  return out
}

/** The strongest status of a set of files (by_status), for ordering groups: read first, untouched last. */
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
    return { about: `what this session read of the folder, by \`thimble coverage\`: ${n(t.files || 0)} source files, ${n(t.read_rows || 0)} of ${n(t.rows || 0)} rows read (${pct(t.read_share || 0)}). A file is read when some of its lines reached Claude; searched when a search showed only its matching lines; counted when it was only named, listed or counted; untouched otherwise` }
  },
  data(stores, _args, size) {
    const s = stores.coverage || {}
    const cov = s.cov
    if (!cov) return { loading: s.error ? null : 'reading what this session read…', error: s.error || null, w: size.w, h: size.h }
    const files = (cov.files || []).map(f => ({ path: f.path, type: f.type || '', group: f.pattern || f.group || f.path, rows: f.rows || 0, lines: f.lines || 0, status: f.status, share: f.share || 0, read_lines: f.read_lines || 0, computed: f.computed || 0, shown: f.shown || 0, hits: f.hits || 0, by: f.by || [], searched_by: f.searched_by || [], queries: f.queries || [], ranges: f.ranges || [], hit_lines: f.hit_lines || [] }))
    const groups = (key, list) => list.map(g => ({ key: g[key], files: g.files, rows: g.rows, read: g.read_rows || 0, by: g.by_status || {} }))
      .sort((a, b) => (rank(a.by) - rank(b.by)) || (b.rows - a.rows) || String(a.key).localeCompare(String(b.key)))
    return {
      total: cov.total || {}, session: cov.session, files, mix: typeMix(cov.types),
      pattern: cov.patterns ? groups('pattern', cov.patterns) : groups('group', cov.groups || []), type: groups('type', cov.types || []), refreshing: !!s.loading, w: size.w, h: size.h,
    }
  },
  program,
}

export function program(k, data) {
  if (!data.files) {
    if (data.error) return k.text(`{bad:×} the coverage could not be read: ${k.escape(data.error)}`)
    return k.text(`{dim:◌ ${k.escape(data.loading || 'reading what this session read…')}}`)
  }
  const st = k.state || {}
  const by = st.by === 'type' ? 'type' : 'pattern'
  const W = Math.max(40, k.w)
  const fileOf = p => data.files.find(f => f.path === p) || null
  const groupList = data[by]
  const group = st.group != null ? groupList.find(g => g.key === st.group) || null : null
  const file = st.file ? fileOf(st.file) : null
  const level = file ? 'file' : group ? 'group' : 'top'

  // ---- the items of this level, in order: what the ring and [ ] step through
  const inGroup = g => data.files.filter(f => (by === 'type' ? f.type : f.group) === g.key)
    .sort((a, b) => STATUS.indexOf(a.status) - STATUS.indexOf(b.status) || a.path.localeCompare(b.path, 'en', { numeric: true }))
  const ranges = file ? rangesOf(file) : []
  const items = level === 'top' ? groupList.map((g, i) => ({ id: `g-${i}`, g })) : level === 'group' ? inGroup(group).map((f, i) => ({ id: `f-${i}`, f })) : ranges.map((r, i) => ({ id: `rg-${i}`, r }))
  const ids = items.map(x => x.id)
  const at = ids.includes(st.at) ? st.at : st.at === 'by-pattern' || st.at === 'by-type' || st.at === 'back' ? st.at : ids[0] || null
  const idx = ids.indexOf(at)

  // ---- what the person does
  const step = dir => () => (ids.length ? { at: ids[Math.max(0, Math.min(ids.length - 1, (idx < 0 ? -1 : idx) + dir))] } : null)
  const open = id => {
    if (id === 'by-pattern' || id === 'by-type') return { by: id.slice(3), group: null, file: null, at: id }
    if (id === 'back') return back()
    const it = items.find(x => x.id === id)
    if (!it) return null
    if (it.g) return { group: it.g.key, file: null, at: 'f-0' }
    if (it.f) return { file: it.f.path, at: 'rg-0' }
    // a read range or the search hits: their lines as a citation, over this pane
    if (it.r && file) { k.do('open', { mark: { kind: 'cite', ref: rangeRef(file, it.r), label: `${file.path} ${rangeWords(it.r)}` } }); return { at: id } }
    return { at: id }
  }
  const back = () => (file ? { file: null, at: `f-${Math.max(0, inGroup(group || { key: null }).findIndex(f => f.path === file.path))}` }
    : group ? { group: null, at: `g-${Math.max(0, groupList.findIndex(g => g.key === group.key))}` } : null)
  k.on('focus', e => (e.region ? { at: e.region } : null))
  k.on('press', e => (e.region === at || e.region === 'back' || e.region === 'by-pattern' || e.region === 'by-type' ? open(e.region) : e.region ? { at: e.region } : null))
  k.on('return', () => (at ? open(at) : null))
  k.on('[', step(-1), level === 'file' ? 'step through what was read' : 'step')
  k.on(']', step(1), level === 'file' ? 'step through what was read' : 'step')
  if (level === 'top') k.on('t', () => ({ by: by === 'type' ? 'pattern' : 'type', group: null, file: null, at: null }), by === 'type' ? 'by pattern' : 'by type')
  if (level !== 'top') k.on('0', back)
  if (level !== 'top') k.on('esc', back, 'back')
  if (at) k.select(at)

  const t = data.total
  const head = level === 'top' ? overview(k, data, W) : []
  if (level === 'top') {
    const rows = Math.max(3, k.h - head.length - 3 - CHROME)
    return k.stack(...head, k.text(' '), toggles(k, by), listOf(k, items, idx, rows, (it, on) => groupRow(k, it.g, by, W, on, it.id), header(k, by === 'type' ? 'type' : 'pattern', W)))
  }
  if (level === 'group') {
    const share = group.rows ? group.read / group.rows : 0
    const title = k.beside(
      k.region('back', { label: 'back to every group' }, k.text('{accent:‹}', { wrap: false })),
      k.text(`${by === 'type' ? `**${k.escape(group.key)}** files` : patternText(k, group.key, true)}{dim: · ${n(group.files)} file${group.files === 1 ? '' : 's'} · ${n(group.rows)} rows}`, { grow: 1, wrap: false }),
      k.text(`read ${n(group.read)} rows {dim:(${pct(share)})}`, { wrap: false }),
      { gap: 1 },
    )
    const rows = Math.max(3, k.h - 4 - CHROME)
    const pw = pathW(items.map(x => x.f), group, by, W)
    return k.stack(title, statusLine(k, group.by), k.text(' '), listOf(k, items, idx, rows, (it, on) => fileRow(k, it.f, group, by, W, pw, on, it.id), fileHeader(k, pw)))
  }
  // ---- one file
  const unit = /^(jsonl|transcript)$/.test(file.type) ? 'rows' : 'lines'
  const total = file.lines || file.rows
  const title = k.beside(
    k.region('back', { label: 'back to the files' }, k.text('{accent:‹}', { wrap: false })),
    k.text(`**${k.escape(file.path)}**{dim: · ${n(total)} ${unit}}`, { grow: 1, wrap: false }),
    k.text(`{${TONE[file.status]}:${SAID[file.status]}}`, { wrap: false }),
    { gap: 1 },
  )
  const out = [title, k.text(`{dim:${k.escape(fileWords(file, unit))}}`, { wrap: false }), strip(k, file, W), k.text(' ')]
  if (!ranges.length && file.status === 'computed') {
    out.push(k.text(`{dim:A query computed over its rows (${k.escape(file.queries.slice(0, 4).join(', ') || 'a query')}); Claude read what the query gave, not the rows themselves.}`))
    return k.stack(out)
  }
  if (!ranges.length) {
    out.push(k.text(`{dim:No line of it reached Claude${file.status === 'named' ? ': it was only named, listed or counted' + (file.by.length ? ` (${k.escape(file.by.join(', '))})` : '') : file.status === 'searched' ? ': a search showed only the lines that matched, and which lines is not known' : ''}.}`))
    return k.stack(out)
  }
  const shown = Math.min(ranges.length, 4)
  out.push(listOf(k, items, idx, shown, (it, on) => rangeRow(k, it.r, on, it.id, unit, file), null))
  out.push(k.text(' '))
  const r = ranges[Math.max(0, idx)] || ranges[0]
  const room = Math.max(3, k.h - out.length - 1 - CHROME)
  const from = Math.max(1, Math.min(r.from - 2, Math.max(1, total - room + 1)))
  const to = Math.min(total || r.to, from + room - 1)
  const got = k.want({ lines: file.path, from, to })
  out.push(linesView(k, file, got, from, to, W))
  return k.stack(out)
}

/** The read ranges of a file, then the lines a search showed (several at a time), to step through. */
export function rangesOf(f) {
  const out = (f.ranges || []).map(([a, b]) => ({ kind: 'read', from: a, to: b }))
  const hits = f.hit_lines || []
  for (let i = 0; i < hits.length && out.length < 60; i += 6) out.push({ kind: 'hit', from: hits[i], to: hits[Math.min(hits.length, i + 6) - 1], lines: hits.slice(i, i + 6) })
  return out
}

/** The overview: the coverage in one line, the type bar, its legend. */
function overview(k, data, W) {
  const t = data.total
  const share = t.read_share || 0
  const top = k.beside(
    k.text(`**Coverage**{dim: of ${data.session === null ? 'every session' : 'this session'} · ${n(t.files || 0)} files · ${n(t.rows || 0)} rows}${data.refreshing ? '{dim: · ◌}' : ''}`, { grow: 1, wrap: false }),
    k.text(`read **${n(t.read_rows || 0)}** rows {dim:(}**${pct(share)}**{dim:)}`, { wrap: false }),
    { gap: 2 },
  )
  const cells = mixCells(data.mix, W)
  const bar = k.text(cells.map(c => `{${c.read ? c.tone : `${c.tone}-faint`}:${'█'.repeat(c.n)}}`).join('') || '{dim:no rows}', { wrap: false })
  // the legend, each type whole on its row (a row ends where the next type would not fit)
  const items = data.mix.map(m => ({ s: `{${m.tone}:■} ${k.escape(m.type)} {dim:${pct(m.rows / Math.max(1, t.rows))}${m.read ? ` · ${pct(m.read / m.rows)} read` : ''}}`, n: 2 + k.len(m.type) + 1 + pct(m.rows / Math.max(1, t.rows)).length + (m.read ? 3 + pct(m.read / m.rows).length + 5 : 0) }))
  const rows = []
  for (const it of items) {
    const last = rows[rows.length - 1]
    if (last && last.n + 3 + it.n <= W) { last.s += `   ${it.s}`; last.n += 3 + it.n } else rows.push({ ...it })
  }
  return [top, k.text(' '), bar, ...rows.map(r => k.text(r.s, { wrap: false }))]
}

function toggles(k, by) {
  const one = (id, words, on) => k.region(id, { label: `group the files ${words}` }, k.text(on ? `{accent:**${words}**}` : `{dim:${words}}`, { wrap: false }))
  return k.beside(one('by-pattern', 'by pattern', by === 'pattern'), k.text('{dim:·}', { wrap: false }), one('by-type', 'by type', by === 'type'), { gap: 1 })
}

// the columns of a group's row: files, read, searched, counted, untouched, then the rows read
const COLS = [['files', 5], ['read', 5], ['searched', 8], ['counted', 7], ['untouched', 9]]
const BAR = 10

function nameW(W) {
  return Math.max(16, W - 3 - COLS.reduce((s, [, w]) => s + w + 1, 0) - (BAR + 8))
}

function header(k, what, W) {
  return k.text(`{dim:  ${pad(what, nameW(W))} ${COLS.map(([h, w]) => pad(h, w, true)).join(' ')}  ${pad('rows read', BAR + 5)}}`, { wrap: false })
}

function groupRow(k, g, by, W, on, id) {
  const nw = nameW(W)
  const cnt = (v, tone, w) => (v ? `{${tone}:${pad(n(v), w, true)}}` : `{dim:${pad('·', w, true)}}`)
  const read = (g.by.computed || 0) + (g.by.read || 0)
  const name = by === 'type' ? (on ? `**${k.escape(cut(g.key, nw))}**` : k.escape(cut(g.key, nw))) : patternText(k, cut(g.key, nw), on)
  const len = Array.from(cut(g.key, nw)).length
  const share = g.rows ? g.read / g.rows : 0
  const fill = Math.round(share * BAR)
  const bar = `{accent:${'█'.repeat(share > 0 ? Math.max(1, fill) : 0)}}{dim:${'·'.repeat(BAR - (share > 0 ? Math.max(1, fill) : 0))}}`
  const line = `${on ? '{accent:**▸**} ' : '  '}${name}${' '.repeat(Math.max(0, nw - len))} ${cnt(g.files, 'ink', 5)} ${cnt(read, 'accent', 5)} ${cnt(g.by.searched, 'warn', 8)} ${cnt(g.by.named, 'dim', 7)} ${cnt(g.by['not read'], 'unseen', 9)}  ${bar} ${pad(pct(share), 5, true)}`
  // a pattern's group carries its pattern, which `thimble rows` reads, so a question about it names its files
  return k.region(id, { label: `${g.key}: ${n(g.files)} files, ${pct(share)} of its rows read`, ...(by === 'pattern' ? { ref: g.key } : {}) }, k.text(line, { wrap: false }))
}

function statusLine(k, by) {
  const parts = [['read', (by.computed || 0) + (by.read || 0), 'accent'], ['searched', by.searched || 0, 'warn'], ['only counted', by.named || 0, 'dim'], ['untouched', by['not read'] || 0, 'unseen']]
  return k.text(parts.filter(([, v]) => v).map(([w, v, tone]) => `{${tone}:${n(v)} ${w}}`).join('{dim: · }'), { wrap: false })
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
  return k.text(`{dim:  ${pad('', 10)}${pad('file', pw)}  ${pad('rows', 8, true)}  what reached Claude}`, { wrap: false })
}

/** What reached Claude of a file, in a few words. */
export function fileWords(f, unit = 'lines') {
  const total = f.lines || f.rows
  if (f.status === 'computed') return `a query computed over ${f.computed >= f.rows ? 'all' : n(f.computed) + ' of'} ${n(f.rows)} rows${f.queries.length ? ` (${f.queries.slice(0, 3).join(', ')})` : ''}${f.read_lines ? `; ${n(f.read_lines)} ${unit} read` : ''}`
  if (f.status === 'read') {
    const r = (f.ranges || []).slice(0, 3).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')
    const more = (f.ranges || []).length > 3 ? ` and ${(f.ranges || []).length - 3} more` : ''
    return `read ${n(f.read_lines || f.shown)} of ${n(total)} ${unit} (${pct((f.read_lines || f.shown) / Math.max(1, total))})${r ? `: ${unit} ${r}${more}` : ''}`
  }
  if (f.status === 'searched') return f.hits ? `searched: only the ${n(f.hits)} matching line${f.hits === 1 ? '' : 's'} shown` : `searched: only matching lines shown${f.searched_by.length ? ` (${f.searched_by.join(', ')})` : ''}`
  if (f.status === 'named') return `only named, listed or counted${f.by.length ? ` (${f.by.slice(0, 4).join(', ')})` : ''}; none of its lines shown`
  return 'untouched'
}

function fileRow(k, f, group, by, W, pw, on, id) {
  const shown = leftCut(nameIn(f, group, by), pw)
  const name = k.escape(shown)
  const words = fileWords(f, /^(jsonl|transcript)$/.test(f.type) ? 'rows' : 'lines')
  const line = `${on ? '{accent:**▸**} ' : '  '}{${TONE[f.status]}:${pad(SAID[f.status], 10)}}${on ? `**${name}**` : name}${' '.repeat(Math.max(0, pw - Array.from(shown).length))}  ${pad(n(f.rows), 8, true)}  {dim:${k.escape(cut(words, Math.max(10, W - pw - 24)))}}`
  return k.region(id, { label: `${f.path}: ${words}`, ref: fileRef(f) }, k.text(line, { wrap: false }))
}

/** A file as a ref: the lines that reached Claude, else the lines a search showed, else the file. */
export function fileRef(f) {
  if ((f.ranges || []).length) return `${f.path}#L${f.ranges.slice(0, 40).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')}`
  if ((f.hit_lines || []).length) return `${f.path}#L${f.hit_lines.slice(0, 60).join(',')}`
  return f.path
}

/** A read range, or a run of search hits, as a ref. */
export function rangeRef(f, r) {
  return r.kind === 'read' ? `${f.path}#L${r.from === r.to ? r.from : `${r.from}-${r.to}`}` : `${f.path}#L${r.lines.join(',')}`
}

const rangeWords = r => (r.kind === 'read' ? (r.from === r.to ? `line ${r.from}` : `lines ${r.from}–${r.to}`) : `lines ${r.lines.join(', ')}`)

function rangeRow(k, r, on, id, unit, f) {
  const words = r.kind === 'read'
    ? `{accent:read}  ${unit} ${r.from === r.to ? n(r.from) : `${n(r.from)}–${n(r.to)}`}{dim:  (${n(r.to - r.from + 1)})}`
    : `{warn:a search showed}  ${r.lines.length === 1 ? 'line' : 'lines'} ${r.lines.map(n).join(', ')}`
  return k.region(id, { label: r.kind === 'read' ? `${f.path}: read ${unit} ${r.from} to ${r.to}` : `${f.path}: search hits at ${r.lines.join(', ')}`, ref: rangeRef(f, r) }, k.text(`${on ? '{accent:**▸**} ' : '  '}${words}`, { wrap: false }))
}

/** The whole file in one row: each cell a stretch of its lines, lit where a read range or a search hit falls. */
function strip(k, f, W) {
  const total = Math.max(1, f.lines || f.rows || 1)
  const w = Math.max(10, W - 2)
  const cell = new Array(w).fill('')
  const at = line => Math.min(w - 1, Math.floor(((line - 1) * w) / total))
  for (const h of f.hit_lines || []) cell[at(h)] = cell[at(h)] || 'hit'
  for (const [a, b] of f.ranges || []) for (let c = at(a); c <= at(b); c++) cell[c] = 'read'
  let s = ''
  for (const c of cell) s += c === 'read' ? '{accent:█}' : c === 'hit' ? '{warn:▌}' : '{unseen:░}'
  return k.text(s, { wrap: false })
}

/** The file's own lines, numbered, those that were read marked ▌ and in ink, the rest dim, a search hit marked. */
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
    if (read.has(no)) return k.text(`{accent:${String(no).padStart(nw)} ▌}${text}`, { wrap: false })
    if (hits.has(no)) return k.text(`{warn:${String(no).padStart(nw)} ▌}${text}`, { wrap: false })
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
