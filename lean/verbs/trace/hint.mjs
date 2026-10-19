// hint.mjs: whether t is worth showing for an object, and the few words the hint row shows for it.
//
//   applies(object) -> a phrase, or null when there is nothing to trace
//
// It reads only what the object already holds (its lineage, citations, data and source), so it is cheap enough to
// ask of every object on screen. The phrase says what t would do for THIS object, not what Trace is.

// a block of a record (#L12.b1), or a set of them (#L12.b0-1,14.b0), exists only in transcripts: words an agent read
// or wrote
const BLOCK = /#L\d+(?:-\d+)?\.b\d+(?:-\d+)?(?:,\d+(?:-\d+)?\.b\d+(?:-\d+)?)*$/

function refsIn(v, out = [], depth = 0) {
  if (depth > 6 || out.length > 40) return out
  if (typeof v === 'string') {
    for (const m of v.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1])
  } else if (Array.isArray(v)) {
    for (const x of v.slice(0, 200)) refsIn(x, out, depth + 1)
  } else if (v && typeof v === 'object') {
    if (typeof v.ref === 'string') out.push(v.ref)
    if (Array.isArray(v._rows) && v._rows.length) out.push(v._rows[0])
    for (const [k, x] of Object.entries(v)) if (k !== '_rows') refsIn(x, out, depth + 1)
  }
  return out
}

export function applies(object) {
  if (!object || typeof object !== 'object') return null
  if (object.verb === 'trace') return object.full ? null : 'full trace'
  const lin = object.lineage || {}
  const cites = (lin.cites || []).map(c => c.ref)
  const refs = [...cites, ...refsIn(object.data), ...refsIn(object.text)]
  if (refs.some(r => BLOCK.test(r))) return 'who read and copied this'
  const bound = (lin.bindings || []).length
  if (bound || Object.keys(lin.rows || {}).length) return 'where these numbers come from'
  if (refs.length) return 'where this came from'
  return null
}
