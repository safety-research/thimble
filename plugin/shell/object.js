// object.js: what the terminal and the browser both need to know of an object, so they say the same thing. No `$`,
// no DOM, no Node: the hooks module, the Node helpers and the browser page all import it.
//
//   forDrawing(object) -> {id, v, title, program, data}: a kernel object as the drawing contract takes it; one saved
//     with no program draws its title and words.
//   chainWords(resolved) -> {line, notes, records}: `thimble resolve --json` in a few words, as both views print it.
//
//   regionRefs(object, drawing, regionId) -> {refs, how}
//     1. the refs the program named: the region meta's `ref` (one or a list; the runtime sets it for a part drawn from
//        a row of the card's data, or matched by its words), the row's own `_ref`, `refs`, `rows` or `_rows`, else its
//        cite's `ref`;
//     2. else the row of the object's data the region stands for, found by name: a row that carries `_rows` (the
//        kernel's source rows) and whose value appears in the region's id, as day "2026-06-18" in "day-2026-06-18";
//        the longest such value wins, and a tie finds none, so a guess never picks between two rows;
//     3. else none.
//   objectRefs(object) -> the refs the object's words cite (its lineage's citations), for the view with no region.
//   recordRefs(drawing, regionId) -> the rows its examples name themselves (`ref` on a record), which need no resolve.
//   fromFacts(object, coverage) -> where an object's values come from, as the detail's "from" line reads it: its
//     sources, rows, labels and coverage (`thimble coverage <id> --json`).
//   barParts(drawing) -> each stacked bar's parts in words, `time: fast start 11.1, after the report 74.1`, since the
//     drawing as plain text shows every part as the same ▆ with no colors; splitsNote(drawing) puts them under it.
//   partLines(object, drawing, ids) -> each part a person can select, in words: its label and the refs it carries.

const KERNEL_REF = /^(?:obj:[A-Za-z0-9][\w.-]*#|[qr]\d+(?:#|@|$)|[^\s#]+#(?:L\d|r\d|\/|[A-Za-z_]))/

/** Whether a string reads as a kernel ref (a query's value, an object's value, or a source row). */
export function isRef(s) {
  return typeof s === 'string' && s.length < 2000 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && KERNEL_REF.test(s)
}

// a file's place as people and editors write it: `server/auth.py:88`, `server/auth.py:88-94` or `:88:5` (a column)
const FILE_LINE = /^((?:\.{0,2}\/)?[\w@+-][\w@+.-]*(?:\/[\w@+.-]+)*\.[A-Za-z0-9]{1,10}):(\d+)(?:[-–](\d+)|:\d+)?$/
// a whole file: a relative path with an extension, no scheme, no spaces, no `#`
const FILE = /^(?:\.{0,2}\/)?[\w@+-][\w@+.-]*(?:\/[\w@+.-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}$/

/**
 * The kernel ref a citation's target names, or null: a kernel ref as written; a file's line as editors write it,
 * `path:88` or `path:88-94`, as the line ref `path#L88` or `path#L88-94`; a file's path alone as the whole file.
 * `loose` (for words that are no link, such as a code span) takes only the line form.
 */
export function citeRef(target, { loose = false } = {}) {
  const t = String(target ?? '').trim()
  if (!t || t.length >= 2000 || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|file|data|javascript):/i.test(t)) return null
  if (!loose && isRef(t)) return t
  const m = FILE_LINE.exec(t)
  if (m) return `${m[1]}#L${m[2]}${m[3] ? `-${m[3]}` : ''}`
  if (!loose && FILE.test(t)) return t
  return null
}

// a part's refs as the program named them: a kernel ref, a file's line as editors write it (`app/x.py:12`), or a file
function listOf(v) {
  return (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string').map(x => citeRef(x)).filter(Boolean)
}

/** The region's meta in the drawing, or null. */
export function regionMeta(drawing, id) {
  const r = (drawing?.regions || []).find(x => x.id === id)
  if (r) return r.meta || {}
  if (drawing?.cites?.[id]) return { cite: id, label: drawing.cites[id].text || id }
  return null
}

export function regionRefs(object, drawing, id) {
  if (!id) return { refs: [], how: '' }
  const meta = regionMeta(drawing, id) || {}
  const own = listOf(meta.ref)
  if (own.length) return { refs: own, how: meta.lineage === 'matched' ? 'matched by its words' : 'named' }
  // a part drawn from a row of the card's data carries that row's own ref, or its source rows
  for (const k of ['_ref', 'refs', 'rows', '_rows']) {
    const got = listOf(meta[k])
    if (got.length) return { refs: got, how: 'its row' }
  }
  const cite = typeof meta.cite === 'string' ? drawing?.cites?.[meta.cite] : meta.cite
  const viaCite = listOf(cite?.ref)
  if (viaCite.length) return { refs: viaCite, how: 'named' }
  const hit = rowByName(object, id)
  if (hit) return { refs: [`obj:${object.id}#${hit.pointer}`], how: `matched by name: ${hit.key} = ${hit.value}` }
  return { refs: [], how: '' }
}

/** The key a part's rows are kept under once resolved: its one ref, or its refs together (resolved as one set). */
export function refsKey(refs) {
  const list = (refs || []).filter(Boolean)
  return list.length > 1 ? list.slice(0, 500).join(' ') : list[0] || ''
}

/** The data row (one that carries `_rows`) whose value the region's id holds; null when none or two tie. */
export function rowByName(object, id) {
  const want = String(id).toLowerCase()
  let best = null
  let tie = false
  const visit = (v, pointer, depth) => {
    if (depth > 3 || v == null || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${pointer}/${i}`, depth + 1)); return }
    if (Array.isArray(v._rows) && v._rows.length) {
      for (const [k, x] of Object.entries(v)) {
        if (k === '_rows' || (typeof x !== 'string' && typeof x !== 'number')) continue
        const s = String(x).toLowerCase()
        if (s.length < 2 || !want.includes(s)) continue
        if (!best || s.length > best.value.length) { best = { pointer, key: k, value: String(x) }; tie = false }
        else if (s.length === best.value.length && best.pointer !== pointer) tie = true
      }
    }
    for (const [k, x] of Object.entries(v)) if (k !== '_rows' && x && typeof x === 'object') visit(x, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1)
  }
  visit(object?.data, '', 0)
  return best && !tie ? best : null
}

// a part's value in words: a whole number as it is, a fraction to three significant digits
const partValue = v => (typeof v !== 'number' || !isFinite(v) ? String(v) : Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : String(Number(v.toPrecision(3))))
const nodeWords = n => (n && n.t === 'text' ? (n.runs || []).map(r => r.s || '').join('').trim() : '')

/** Each stacked bar's parts in words, in reading order. A bar is named by the words before it in its row (a k.bars
 *  label), else by the label of the part of the card it is in. */
export function barParts(drawing) {
  const out = []
  const say = (name, bar) => out.push(`${name || 'a bar'}: ${bar.parts.map((p, i) => `${p.label != null && String(p.label).trim() ? String(p.label).trim() : `part ${i + 1}`} ${partValue(p.value)}`).join(', ')}`)
  const stacked = n => n && n.t === 'bar' && Array.isArray(n.parts) && n.parts.length > 1
  const walk = (n, name) => {
    if (!n || typeof n !== 'object') return
    if (n.t === 'region' && n.meta?.label) name = String(n.meta.label)
    if (stacked(n)) { say(name, n); return }
    const kids = Array.isArray(n.kids) ? n.kids : []
    kids.forEach((k, i) => {
      // in a row, the nearest words before the bar name it
      const before = n.t === 'beside' && stacked(k) ? kids.slice(0, i).reverse().map(nodeWords).find(Boolean) : ''
      walk(k, before || name)
    })
    if (n.kid) walk(n.kid, name)
  }
  walk(drawing?.root, '')
  return out
}

/** What the plain text of a drawing loses, said under it: the colors, and so the splits of its stacked bars, with each
 *  bar's parts listed in words. '' when the drawing has no stacked bar. */
export function splitsNote(drawing) {
  const bars = barParts(drawing)
  if (!bars.length) return ''
  return `\n\nThis plain text has no colors, so the parts of a stacked bar above are all the same ▆ and do not show where one part ends. Each stacked bar's parts, with their values:\n${bars.map(b => `- ${b}`).join('\n')}`
}

/** Each part a person can select (`ids`, in reading order), in words: its label, then the refs it carries. */
export function partLines(object, drawing, ids, { max = 40, refsEach = 6 } = {}) {
  const out = []
  for (const id of ids.slice(0, max)) {
    const label = String(regionMeta(drawing, id)?.label || id).trim()
    const refs = regionRefs(object, drawing, id).refs
    out.push(`- ${label}${refs.length ? `: ${refs.slice(0, refsEach).join(', ')}${refs.length > refsEach ? ', …' : ''}` : ''}`)
  }
  if (ids.length > max) out.push(`- and ${ids.length - max} more parts`)
  return out
}

/** The refs the object's words cite, as the kernel checked them at save. */
export function objectRefs(object) {
  const cites = object?.lineage?.cites || []
  return cites.map(c => ({ ref: c.ref, label: c.label ?? c.ref, problem: c.problem || null })).filter(c => isRef(c.ref))
}

/** The rows a region's examples name themselves: [{ref, text}] from records that carry a `ref`. */
export function recordRefs(drawing, id) {
  const meta = regionMeta(drawing, id) || {}
  const set = typeof meta.examples === 'string' ? drawing?.examples?.[meta.examples] : null
  return (set?.records || []).filter(r => r && isRef(r.ref)).map(r => ({ ref: r.ref, text: r.text ?? r.quote ?? '' }))
}

// An object saved with no program still draws: its title and its words, each citation as the words it links.
const PLAIN = `return k.frame(k.text(data.text || '{dim:no program and no text}'), { title: data.title || data.id })`

export function forDrawing(object) {
  const o = { ...object, v: object.v ?? object.version }
  if (!o.program) {
    const text = String(o.text || '').replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    return { ...o, program: PLAIN, data: { title: o.title, id: o.id, text } }
  }
  return o
}

const n = x => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))

/** `thimble resolve --json` in words: "r1 · saves per day ← 6,543 rows of revisions.jsonl", its notes and its records. */
export function chainWords(r) {
  if (!r) return { line: '', notes: [], records: [] }
  if (r.error) return { line: '', notes: [String(r.error)], records: [], error: true }
  const steps = []
  for (const c of r.chain || []) {
    if (c.step === 'query') steps.push(`${c.id}${c.about ? ' · ' + c.about : ''}`)
    else if (c.step === 'object' && steps.length === 0 && c.at == null) steps.push(`${c.title || c.id}`)
  }
  const files = [...new Set((r.rows || []).map(x => String(x).split('#')[0]))]
  const where = files.length === 1 ? files[0] : files.length ? `${files.length} files` : ''
  const count = r.count != null ? `${n(r.count)} source row${r.count === 1 ? '' : 's'}${where ? ' in ' + where : ''}` : where ? `all of ${where}` : 'no source rows'
  steps.push(count)
  const notes = [...(r.notes || [])]
  const check = (r.chain || []).map(c => c.check).filter(Boolean).pop()
  if (check && !/equals/.test(check)) notes.push(check)
  return { line: steps.join(' ← '), notes, records: r.records || [] }
}

/** Where an object's values come from, in the few facts the "from" line shows. `cov` is `thimble coverage <id> --json`. */
export function fromFacts(object, cov) {
  const lin = object?.lineage || {}
  const rows = lin.rows || {}
  const sources = Object.entries(rows).map(([path, x]) => ({ path, rows: Number(x?.count) || 0 }))
  for (const q of Object.values(lin.queries || {})) {
    for (const x of q?.inputs || []) if (x?.path && !sources.some(s => s.path === x.path)) sources.push({ path: x.path, rows: null })
  }
  // a label is a query's kept column (CONTRACT: a label is a query that keeps a column), named where it is used
  const labels = []
  for (const q of Object.values(lin.queries || {})) {
    for (const u of q?.uses || []) if (u?.name && !/^[qr]\d+$/.test(u.name) && !labels.includes(u.name)) labels.push(u.name)
    for (const k of q?.kept || []) if (k && !labels.includes(k)) labels.push(k)
  }
  const out = { sources, rows: sources.reduce((n, s) => n + (s.rows || 0), 0), labels }
  if (cov && !cov.error && Array.isArray(cov.feeding)) {
    const all = cov.feeding.length + (cov.not_feeding || []).length
    out.coverage = { feeding: cov.feeding.length, files: all, notFeeding: (cov.not_feeding || []).slice(0, 12) }
    for (const f of cov.feeding) { const s = out.sources.find(x => x.path === f.path); if (s && f.of != null) s.of = f.of }
  }
  const t = lin.coverage?.total
  if (t) out.session = { files: t.files, notReadFiles: t.not_read_files, notReadRows: t.not_read_rows }
  return out
}
