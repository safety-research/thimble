// coverage-view.mjs: the coverage pane (panes/coverage.tsx) as pure functions over the last `thimble coverage --json`
// (engine/kernel/coverage.py says what each measure is). No `$`, no DOM: coverage.tsx draws what this returns with
// Claude Code's own elements, and the tests read it as text.
//
//   the head     `Coverage` and, at the right, how many of the folder's files Claude touched. One bar for the whole
//                folder in three shades: files read into Claude's context (█), files only computed over or searched
//                (█ in gray), files untouched (░); its key under it, then a dim `touched` over the count column
//   the tree     one line per row: a folder or a file, its name cut with … to fit, a 12-cell bar of the same three
//                shades, and the files touched (`16/904`). ↵ opens a folder one level (its own files and folders) and
//                closes it again; j k move. A tree taller than the room scrolls with the selection, and a dim line
//                under it says which rows show
//   the detail   the file picked, under a rule: in its own unit (lines, records, rows, pages), how much entered
//                Claude's context, how much code computed over, a search went over, a label's model read; a file of
//                no unit (an image) is read or not as a whole
//
// A pane under 48 columns draws no bars in the rows. Before Claude touched anything the bar is empty and the rows dim,
// with their file counts.
import { cut, textWidth } from '../core/text.js'

/** Cells of a row's bar, and of the detail's. */
export const ROW_BAR = 12
export const FILE_BAR = 24
/** Under this many columns the rows have no bar. */
export const NARROW = 48
/** The extensions of images, for a file the kernel did not touch (and so gave no kind). */
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic'])

const n0 = x => Number(x) || 0
const num = x => Math.round(n0(x)).toLocaleString('en-US')
const width = textWidth
const pad = (s, n) => { const t = cut(s, n); return t + ' '.repeat(Math.max(0, n - width(t))) }
const padStart = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + s

/** A share as the pane says it: 0%, <0.1%, 1.7%, 34%, and 100% only when all. */
export function pct(part, all) {
  if (!(all > 0) || !(part > 0)) return '0%'
  if (part >= all) return '100%'
  const x = (part / all) * 100
  if (x < 0.1) return '<0.1%'
  if (x < 9.95) return `${x.toFixed(1).replace(/\.0$/, '')}%`
  return `${Math.min(99, Math.round(x))}%`
}

/** A bar of `w` cells: `read` of `all` in █, `comp` in █ (gray), the rest ░; a part above none takes one cell at least. */
export function bar(read, comp, all, w) {
  const cells = x => (x <= 0 || !(all > 0) ? 0 : Math.max(1, Math.round((x / all) * w)))
  const r = Math.min(w, cells(read))
  const c = Math.min(w - r, cells(comp))
  return [
    ...(r ? [{ s: '█'.repeat(r), tone: 'read' }] : []),
    ...(c ? [{ s: '█'.repeat(c), tone: 'comp' }] : []),
    ...(w - r - c ? [{ s: '░'.repeat(w - r - c), tone: 'track' }] : []),
  ]
}

const folderOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : './')
const nameOf = p => { const t = p.replace(/\/$/, ''); return t.slice(t.lastIndexOf('/') + 1) + (p.endsWith('/') ? '/' : '') }
const extOf = p => { const n = nameOf(p); const d = n.lastIndexOf('.'); return d > 0 ? n.slice(d + 1).toLowerCase() : '' }

const node = path => ({ path, files: 0, touched: 0, seen: 0, kids: new Map(), own: [], more: 0 })

/** The folder tree of the kernel's groups (one per folder that holds files), each folder with its files, files
 *  touched and files read, its own and those of the folders under it; and each folder's own files: those touched
 *  (`files`), those not touched the kernel named (`untouched`), and how many more it did not name. */
export function folderTree(cov) {
  const root = node('')
  const at = new Map([['./', root]])
  const folder = f => {
    if (at.has(f)) return at.get(f)
    const parts = f.replace(/\/$/, '').split('/')
    let cur = root
    parts.forEach((_, i) => {
      const p = `${parts.slice(0, i + 1).join('/')}/`
      if (!cur.kids.has(p)) cur.kids.set(p, node(p))
      cur = cur.kids.get(p)
      at.set(p, cur)
    })
    return cur
  }
  const chain = f => { const out = [root]; if (f === './') return out; const parts = f.replace(/\/$/, '').split('/'); parts.forEach((_, i) => out.push(folder(`${parts.slice(0, i + 1).join('/')}/`))); return out }
  for (const g of cov?.groups || []) {
    const f = String(g.folder || './')
    folder(f === './' ? './' : f)
    for (const n of chain(f)) {
      n.files += n0(g.files)
      n.touched += n0(g.touched)
      n.seen += n0(g.seen_files)
    }
  }
  for (const o of cov?.files || []) folder(folderOf(String(o.path))).own.push({ ...o, path: String(o.path), touched: true })
  const u = cov?.untouched || {}
  ;(Array.isArray(u.path) ? u.path : []).forEach((p, i) => {
    folder(folderOf(String(p))).own.push({ path: String(p), unit: u.unit?.[i] ?? 'file', units: n0(u.units?.[i]) || 1, by: u.by?.[i] ?? '', touched: false })
  })
  for (const g of cov?.groups || []) {
    const n = folder(String(g.folder || './'))
    n.more = Math.max(0, n0(g.files) - n.own.length)
  }
  return root
}

const byTouch = (a, b) => b.touched - a.touched || b.files - a.files || a.path.localeCompare(b.path)
const rank = f => (!f.touched ? 2 : f.seen ? 0 : 1)
const byFile = (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)

/** The folder open when the person has opened none yet: the top folder Claude touched the most files of. */
export function openAtFirst(cov) {
  const top = [...folderTree(cov).kids.values()].sort(byTouch)[0]
  return top?.touched ? [top.path] : []
}

/** The tree's rows as they show, each a folder or a file, with its depth. */
export function treeRows(tree, open) {
  const rows = []
  const walk = (n, depth) => {
    for (const k of [...n.kids.values()].sort(byTouch)) {
      rows.push({ key: `dir:${k.path}`, kind: 'dir', node: k, depth, open: open.has(k.path) })
      if (open.has(k.path)) walk(k, depth + 1)
    }
    for (const f of [...n.own].sort(byFile)) rows.push({ key: `file:${f.path}`, kind: 'file', file: f, depth })
    if (n.more) rows.push({ key: `more:${n.path || './'}`, kind: 'more', count: n.more, depth })
  }
  walk(tree, 0)
  return rows
}

/** The first row a window of `room` rows over `n` shows, so that row `sel` is in it, moving as little as it can from
 *  `top`. */
export function windowTop(top, sel, room, n) {
  if (n <= room) return 0
  let t = Math.max(0, Math.min(n0(top), n - room))
  if (sel >= 0 && sel < t) t = sel
  if (sel >= 0 && sel >= t + room) t = sel - room + 1
  return t
}

const unitWord = (u, n) => (u === 'file' ? (n === 1 ? 'file' : 'files') : n === 1 ? u.replace(/s$/, '') : u)

/** A file's own unit as the detail says its size: `1,617 records`, `12 pages`, `image`. */
function sizeOf(f) {
  if ((f.unit || 'file') !== 'file') return `${num(f.units)} ${unitWord(f.unit, n0(f.units))}`
  const k = String(f.kind || '')
  return ['image', 'audio', 'video'].includes(k) ? k : IMAGE.has(extOf(f.path)) ? 'image' : 'file'
}

/** Runs cut to `W` cells, the last one shown with … where it was cut. */
export function fitRuns(runs, W) {
  const out = []
  let left = W
  for (const r of runs) {
    if (left <= 0) break
    const w = width(r.s)
    out.push(w <= left ? r : { ...r, s: cut(r.s, left) })
    left -= Math.min(w, left)
  }
  return out
}

/** What happened to the file picked, as lines of runs under the rule, each at most `W` cells. */
export function fileDetail(f, W) {
  return detailLines(f, W).map(runs => fitRuns(runs, W))
}

function detailLines(f, W) {
  const lines = []
  const where = folderOf(f.path)
  // the folder cut in its middle to leave the name and the size whole
  const size = ` · ${sizeOf(f)}`
  lines.push([{ s: nameOf(f.path), tone: 'bold' }, { s: `  ${cut(where, Math.max(4, W - width(nameOf(f.path)) - 2 - width(size)), true)}${size}`, tone: 'dim' }])
  const tools = xs => (xs || []).filter(Boolean).slice(0, 4).join(', ')
  const ruled = (f.labels || []).filter(l => !(f.model_labels || []).includes(l))
  const computedBy = tools([...ruled, ...(f.computed_by || [])])
  const listedBy = String(f.by || '')
  if ((f.unit || 'file') === 'file') {
    // a file of no unit is read or not, as a whole
    if (!f.touched) lines.push([{ s: '░ ', tone: 'track' }, { s: listedBy ? 'only listed by name, not in Claude\'s context' : 'untouched', tone: 'dim' }, ...(listedBy ? [{ s: `  ${listedBy}`, tone: 'dim' }] : [])])
    else if (f.seen) lines.push([{ s: '█ ', tone: 'read' }, { s: "in Claude's context", tone: null }])
    else {
      const how = n0(f.model) ? ["read by a label's model", tools(f.model_labels)] : f.searched ? ['searched', tools(f.searched_by)] : ['computed over', computedBy]
      lines.push([{ s: '█ ', tone: 'comp' }, { s: `${how[0]}, not in Claude's context`, tone: null }, ...(how[1] ? [{ s: `  ${how[1]}`, tone: 'dim' }] : [])])
    }
    return lines
  }
  const all = n0(f.units)
  const seen = f.touched ? n0(f.seen_units) : 0
  const other = f.touched ? n0(f.model_units) + n0(f.searched_units) + n0(f.computed_units) : 0
  lines.push(bar(seen, other, all, Math.min(FILE_BAR, W)))
  const rows = [['█', 'read', "in Claude's context", seen, '']]
  if (f.touched) {
    const computed = n0(f.computed_over_units ?? f.computed_units)
    const model = n0(f.model_read_units ?? f.model_units)
    if (computed) rows.push(['█', 'comp', 'computed over', computed, computedBy])
    if (f.searched) rows.push(['█', 'comp', 'searched', all, tools(f.searched_by)])
    if (model) rows.push(['█', 'comp', "read by a label's model", model, tools(f.model_labels)])
  }
  const amounts = rows.map(([, , , part], i) => `${num(part)}/${num(all)}${i ? '' : ` ${unitWord(f.unit, all)}`}`)
  const amountW = Math.max(...amounts.map(width))
  rows.forEach(([glyph, tone, said, part, by], i) => {
    lines.push([{ s: `${glyph} `, tone }, { s: pad(said, 25), tone: null },
      { s: `${pad(amounts[i], amountW)} ${padStart(pct(part, all), 5)}`, tone: 'dim' }, ...(by ? [{ s: `  ${by}`, tone: 'dim' }] : [])])
  })
  if (!f.touched) lines.push([{ s: '░ ', tone: 'track' }, { s: listedBy ? 'only listed by name' : 'untouched', tone: 'dim' }, ...(listedBy ? [{ s: `  ${listedBy}`, tone: 'dim' }] : [])])
  return lines
}

/** The pane as lines of runs over `W` columns and about `H` rows (the room `under` keeps for the thread under the
 *  pane left out): `lines`, the selectable rows' keys in order (`keys`), the row selected (`sel`, -1 for none), the
 *  window (`top`, `room`), and `head` and `tail`, the rows before and after the tree. Each tree line carries its row's
 *  key as `press`, and `sel` when it is the one selected. */
export function coverageView(cov, view, { W, H, under = 0 }) {
  const narrow = W < NARROW
  const t = cov?.total || {}
  const files = n0(t.files)
  const touched = n0(t.touched_files)
  const seen = n0(t.seen_files)
  const none = touched === 0
  const allRead = files > 0 && seen >= files
  const tree = folderTree(cov)
  const open = new Set(view?.open ?? openAtFirst(cov))
  const rows = treeRows(tree, open)
  const keys = rows.filter(r => r.kind !== 'more').map(r => r.key)
  const selKey = view?.sel && rows.some(r => r.key === view.sel) ? view.sel : null
  const sel = selKey ? rows.findIndex(r => r.key === selKey) : -1

  // ---- the head
  const head = []
  const right = none ? 'nothing touched yet' : `${num(touched)}/${num(files)} ${narrow ? 'touched' : 'files touched'} · ${pct(touched, files)}`
  head.push([{ s: 'Coverage', tone: 'bold' }, { s: padStart(cut(right, W - 9), W - 8), tone: none ? 'dim' : null }])
  head.push(bar(seen, touched - seen, files, W))
  if (none) head.push([])
  else if (narrow) {
    head.push([{ s: '█', tone: 'read' }, { s: ` in context ${num(seen)}  `, tone: 'dim' }, { s: '█', tone: 'comp' }, { s: ` computed ${num(touched - seen)}  `, tone: 'dim' }, { s: '░', tone: 'track' }, { s: ' untouched', tone: 'dim' }])
    head.push([])
  } else {
    head.push([{ s: '█', tone: 'read' }, { s: ` read into Claude's context ${num(seen)}`, tone: 'dim' }])
    head.push([{ s: '█', tone: 'comp' }, { s: ` computed over or searched, not in its context ${num(touched - seen)}   `, tone: 'dim' }, { s: '░', tone: 'track' }, { s: ' untouched', tone: 'dim' }])
    head.push([])
  }

  // ---- the rows: name, bar, count; the count column as wide as its widest
  const countOf = r => {
    if (r.kind === 'more') return ''
    if (none) { const n = r.kind === 'dir' ? r.node.files : 1; return `${num(n)} ${n === 1 ? 'file' : 'files'}` }
    if (r.kind === 'dir') return allRead ? `all ${num(r.node.files)}` : `${num(r.node.touched)}/${num(r.node.files)}`
    return allRead ? 'read' : r.file.touched ? '1/1' : '0/1'
  }
  const counts = rows.map(countOf)
  const bars = !narrow && !none
  const CW = Math.max(bars ? 7 : 0, ...counts.map(width))
  const nameW = Math.max(6, bars ? W - 3 - ROW_BAR - CW : W - 1 - CW)
  if (bars) head.push([{ s: `${' '.repeat(nameW + 1 + ROW_BAR + 2)}touched`, tone: 'dim' }])
  const line = (r, i) => {
    const ind = '  '.repeat(r.depth)
    if (r.kind === 'more') return { key: r.key, runs: [{ s: cut(`${ind}  … ${num(r.count)} more ${r.count === 1 ? 'file' : 'files'}, none touched`, W), tone: 'dim' }] }
    const name = r.kind === 'dir' ? nameOf(r.node.path) : nameOf(r.file.path)
    const mark = r.kind === 'dir' ? (r.open ? '▾ ' : '▸ ') : '  '
    const lead = `${ind}${mark}`
    const shown = pad(lead + cut(name, Math.max(1, nameW - width(lead)), true), nameW)
    const [read, comp, all] = r.kind === 'dir'
      ? [r.node.seen, r.node.touched - r.node.seen, r.node.files]
      : [r.file.touched && r.file.seen ? 1 : 0, r.file.touched && !r.file.seen ? 1 : 0, 1]
    const runs = [{ s: shown, tone: none ? 'dim' : null }]
    if (bars) runs.push({ s: ' ', tone: null }, ...bar(read, comp, all, ROW_BAR), { s: `  ${pad(counts[i], CW)}`, tone: 'dim' })
    else runs.push({ s: ` ${none ? padStart(counts[i], CW) : pad(counts[i], CW)}`, tone: 'dim' })
    return { key: r.key, runs, press: r.key, ...(i === sel ? { sel: true } : {}) }
  }

  // ---- the detail of the file picked
  const picked = sel >= 0 && rows[sel].kind === 'file' ? rows[sel].file : null
  const tail = picked ? [[{ s: '─'.repeat(W), tone: 'rule' }], ...fileDetail(picked, W)] : []

  // ---- the window: the head, the detail and the keys (a rule and a row) stay; the tree scrolls
  const room0 = Math.max(3, n0(H) - n0(under) - head.length - tail.length - 2)
  const room = rows.length > room0 ? Math.max(2, room0 - 1) : room0
  const top = windowTop(view?.top, sel, room, rows.length)
  const shown = rows.slice(top, top + room)
  const lines = [
    ...head.map((runs, i) => ({ key: `h${i}`, runs })),
    ...shown.map((r, i) => line(r, top + i)),
    ...(rows.length > room ? [{ key: 'window', runs: [{ s: padStart(`rows ${top + 1}–${top + shown.length} of ${rows.length}`, W), tone: 'dim' }] }] : []),
    ...tail.map((runs, i) => ({ key: `d${i}`, runs })),
  ]
  return { lines, keys, sel, selKey, top, room, rows: rows.length, open: [...open], picked: picked?.path ?? null,
    isDir: sel >= 0 && rows[sel].kind === 'dir', anyOpen: open.size > 0 }
}

/** The view after j (`d` 1) or k (`d` -1): the next selectable row, the window moved to keep it in view. */
export function stepView(cov, view, d, dims) {
  const v = coverageView(cov, view, dims)
  if (!v.keys.length) return view
  const at = v.selKey ? v.keys.indexOf(v.selKey) : -1
  const next = v.keys[at < 0 ? 0 : Math.max(0, Math.min(v.keys.length - 1, at + d))]
  const after = coverageView(cov, { ...view, open: v.open, sel: next }, dims)
  return { ...view, open: v.open, sel: next, top: windowTop(v.top, after.sel, after.room, after.rows) }
}

/** The view after ↵ (or a press) on a row: a folder opens one level, or closes; a file is picked. */
export function pressView(cov, view, key, dims) {
  const v = coverageView(cov, view, dims)
  const open = new Set(v.open)
  if (key.startsWith('dir:')) {
    const p = key.slice(4)
    if (open.has(p)) open.delete(p)
    else open.add(p)
  }
  const nextView = { ...view, open: [...open], sel: key }
  const after = coverageView(cov, nextView, dims)
  return { ...nextView, top: windowTop(v.top, after.sel, after.room, after.rows) }
}

/** The lines as plain text, for the tests and for a look in a terminal. */
export function textOf(v) {
  return v.lines.map(l => l.runs.map(r => r.s).join('')).join('\n')
}
