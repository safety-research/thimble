// hint.mjs: whether m is worth a visible hint under an object, and its words there.
//
//   applies(object) -> a phrase for THIS object, or null
//
// It reads only what the object holds (its program, data and lineage), so the shell can ask it of every object drawn.
//   a mini map               "full map · 12 stations"
//   a full map               "map the threads of one station"
//   an object over runs      "map the 48 runs" (its rows come from agent, run or session transcripts)
// Other objects get no hint: m stays in `?` for them, where pressing it asks Claude to map the work.
import { isMap } from './run.mjs'

const fmt = n => Number(n).toLocaleString('en-US')

export function applies(object) {
  if (!object || typeof object !== 'object') return null
  if (isMap(object)) {
    const d = object.data || {}
    if (d.full) return 'map the threads of one station'
    const n = count(d, ['stations', 'nodes', 'places', 'concepts'])
    return n ? `full map · ${fmt(n)} stations` : 'full map'
  }
  const rows = (object.lineage && object.lineage.rows) || {}
  const files = Object.keys(rows)
  if (!files.length) return null
  const runs = files.filter(f => /(agent|run|session|transcript|trajector)/i.test(f) && /\.jsonl$/i.test(f))
  if (runs.length >= 2) return `map the ${fmt(runs.length)} runs`
  if (runs.length === 1) return 'map this run'
  return null
}

function count(d, keys) {
  for (const k of keys) {
    const v = d[k]
    if (Array.isArray(v)) return v.length
    if (v && typeof v === 'object') return Object.keys(v).length
  }
  return 0
}
