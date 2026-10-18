// object.js: what the terminal and the browser both need to know of an object, so they say the same thing. No `$`,
// no DOM, no Node: the hooks module, the Node helpers and the browser page all import it.
//
//   forDrawing(object) -> {id, v, title, program, data}: a kernel object as the drawing contract takes it; one saved
//     with no program draws its title and words.
//   chainWords(resolved) -> {line, notes, records}: `lean resolve --json` in a few words, as both views print it.
//
//   regionRefs(object, drawing, regionId) -> {refs, how}
//     1. the refs the program named: the region meta's `ref` (one or a list), else its cite's `ref`;
//     2. else the row of the object's data the region stands for, found by name: a row that carries `_rows` (the
//        kernel's source rows) and whose value appears in the region's id, as day "2026-06-18" in "day-2026-06-18";
//        the longest such value wins, and a tie finds none, so a guess never picks between two rows;
//     3. else none.
//   objectRefs(object) -> the refs the object's words cite (its lineage's citations), for the view with no region.
//   recordRefs(drawing, regionId) -> the rows its examples name themselves (`ref` on a record), which need no resolve.

const KERNEL_REF = /^(?:obj:[A-Za-z0-9][\w.-]*#|q\d+(?:#|$)|[^\s#]+#(?:L\d|r\d|\/|[A-Za-z_]))/

/** Whether a string reads as a kernel ref (a query's value, an object's value, or a source row). */
export function isRef(s) {
  return typeof s === 'string' && s.length < 2000 && KERNEL_REF.test(s)
}

function listOf(v) {
  return (Array.isArray(v) ? v : [v]).filter(isRef)
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
  if (own.length) return { refs: own, how: 'named' }
  const cite = typeof meta.cite === 'string' ? drawing?.cites?.[meta.cite] : meta.cite
  const viaCite = listOf(cite?.ref)
  if (viaCite.length) return { refs: viaCite, how: 'named' }
  const hit = rowByName(object, id)
  if (hit) return { refs: [`obj:${object.id}#${hit.pointer}`], how: `matched by name: ${hit.key} = ${hit.value}` }
  return { refs: [], how: '' }
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

/** `lean resolve --json` in words: "q1 · saves per day ← 6,543 rows of revisions.jsonl", its notes and its records. */
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

