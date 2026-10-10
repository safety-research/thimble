// The derived fields of profile_types.py whose code is JavaScript, such as `(p, all) => all.Post.filter((q) =>
// q.reply_to === p.id).length` (views round 5; exploration).
//
//   node profile_derive.mjs <input.json>
//
// The input holds the records by type ({types: {Name: [record]}}) and the derived fields in the order the types list
// them ({derived: [{type, field, code, only}]}, `only` the indices of the records of a union's branch, or null). Each
// field's code is a function of the record and of `all`, the records by type (all.Post), or an expression of `r` and
// `all`. A type's fields are computed the first time anything reads the type, so a field can read the derived fields
// of another type. Prints {values: {"Type.field": [[index, value], ...]}, errors: {"Type.field": [count, [example]]}}:
// a value that is not JSON becomes its string, and code that throws gives null on that record. It reads nothing else
// and writes nothing but its answer.
import fs from 'node:fs'

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const recs = input.types || {}
const byType = {}
for (const d of input.derived || []) (byType[d.type] ||= []).push(d)
const state = {}
const values = {}
const errors = {}

const all = new Proxy({}, {
  get(_, name) {
    if (typeof name !== 'string') return undefined
    ensure(name)
    return recs[name] || []
  },
})

function compile(code) {
  const src = String(code || '').trim().replace(/;$/, '')
  try {
    const fn = (0, eval)('(' + src + ')')
    if (typeof fn === 'function') return fn
  } catch (e) {
    // not a function expression: an expression of r and all, below
  }
  return new Function('r', 'all', 'return (' + src + ')')
}

function plain(v) {
  if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return null
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Set) return [...v]
  if (v instanceof Map) return Object.fromEntries(v)
  return v
}

function ensure(type) {
  if (state[type]) return
  state[type] = 'deriving'
  const rows = recs[type] || []
  for (const d of byType[type] || []) {
    const key = `${type}.${d.field}`
    const err = (errors[key] = [0, []])
    let fn
    try {
      fn = compile(d.code)
    } catch (e) {
      err[0] = -1
      err[1].push(`its code does not compile: ${String(e.message || e).slice(0, 120)}`)
      continue
    }
    const out = (values[key] = [])
    const idx = Array.isArray(d.only) ? d.only : rows.map((_, i) => i)
    for (const i of idx) {
      const r = rows[i]
      let v = null
      try {
        v = plain(fn(r, all))
      } catch (e) {
        err[0] += 1
        if (err[1].length < 2) err[1].push(`${e && e.name ? e.name : 'Error'}: ${String((e && e.message) || e).slice(0, 80)} at ${r && r._ref}`)
      }
      r[d.field] = v
      out.push([i, v])
    }
  }
  state[type] = 'done'
}

for (const type of Object.keys(byType)) ensure(type)
process.stdout.write(JSON.stringify({ values, errors }, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
