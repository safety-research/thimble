// run.mjs: the Map verb (key m). Map lays the work out by its own structure, so its shape is visible: one long run as
// a line of its stations, many runs or a swarm as a metro map whose bundles fork and merge, a dataset or a report as
// regions of what it holds. It absorbs Trail (Claude declares threads, stations and "same move" links), Atlas
// (concepts in regions) and view proposals (a map is an object that stays, re-drawn from its lineage).
//
//   run(ctx) -> {object?, text?, note?, ask?}      ctx as shell/node/verb.mjs builds it
//
// ---------------------------------------------------------------------------------------------- who writes the map
// Claude, in the main conversation, guided by SKILL.md: it decides the threads, stations and links, computes them with
// `lean q` and saves the map with `lean save`. A map is a short spec in the object's data; the drawing is code (k.map in
// the drawing toolkit), so no model draws cells. Why main and not a quiet $.model.complete call:
//   - lineage: a station is a claim about many rows ("12 runs reran the test with no change"). Main counts it in code
//     over every run, so the count covers all of them and each station keeps its rows. A quiet call would see only
//     what fits in its prompt, and its stations would rest on a sample nobody can open.
//   - Manual mode stays manual: main reads with its own tools, which the permission mode asks about. A quiet call
//     would have to read transcripts on the verb's behalf, past the asks.
//   - cost: main has usually read the work already to answer; the spec is a few hundred tokens of JSON. A quiet call
//     would read the same transcripts again.
//   - clutter: the price is one `lean q` row and one `lean save` row in the chat. The skill asks for no more, and the
//     person sees the map under the reply, not its spec.
// So pressing m on something that is not a map yet asks Claude to map it (`ask`, a prompt the person sees as sent by
// thimble). Everything else the verb does is code, with no model:
//   m on a map          the full map, opened in the detail view. Until the shell draws the detail view with
//                       k.mode 'detail' (where the same object shows in full), this is a sibling object
//                       `<name>-full`, kept once per version.
//   m on a station      a map of the threads through it (a lane: the threads in it); one thread is drawn as its own
//                       line. Its data is the map's, filtered, so each station still names its rows.
//   m on anything else  asks Claude to map it.

/** The program a map object draws with: Claude may write its own around k.map, or leave the program out. */
export const PROGRAM = "return k.frame(k.map(data), { title: data.title || 'map', right: data.right || '' })"

const THREAD_KEYS = ['threads', 'runs', 'agents', 'lines', 'trails']
const MOVE_KEYS = ['moves', 'visits', 'stops', 'steps_list']
const ref = o => `obj:${o.id}@${o.version}`
const slugOf = id => String(id || 'map').replace(/^\d+-/, '')

/** Whether an object is a map: its program calls k.map, or it was made by this verb. */
export function isMap(o) {
  return !!o && (/\bk\.map\(/.test(String(o.program || '')) || o.verb === 'map')
}

/** The threads a region stands for: a lane's or a station's `threads`, as k.map records them in the region's meta. */
export function threadsOf(meta) {
  return Array.isArray(meta && meta.threads) ? meta.threads.map(String) : []
}

/** The map's data with only these threads (and their moves); stations and groups are kept, so names still read. */
export function filterThreads(data, keep) {
  const set = new Set(keep)
  const idOf = t => (t && typeof t === 'object' ? String(t.id ?? t.thread ?? t.run ?? t.agent ?? t.name ?? t.label ?? '') : String(t))
  const out = {}
  for (const [k, v] of Object.entries(data || {})) {
    if (THREAD_KEYS.includes(k)) {
      if (Array.isArray(v)) out[k] = v.filter(t => set.has(idOf(t)))
      else if (v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).filter(([id]) => set.has(id)))
      else out[k] = v
    } else if (MOVE_KEYS.includes(k) && Array.isArray(v)) {
      out[k] = v.filter(m => !m || typeof m !== 'object' || set.has(String(m.thread ?? m.run ?? m.agent ?? '')))
    } else out[k] = v
  }
  return out
}

/** The full map of a map object: the object saved again as `<name>-full` with full: true, once per version. */
async function fullMap(ctx, o) {
  const name = `${slugOf(o.id)}-full`
  const have = ctx.kernel.list(name)
  if (have && !have.error && have.lineage?.declared?.from === ref(o)) {
    return { object: { id: have.id, version: have.version }, text: `The full map of ${o.title || o.id} is open in the detail view.`, note: `The person opened the full map of ${ref(o)}: ${have.id}@${have.version}.` }
  }
  // the spec as Claude gave it (query refs unbound), so the kernel binds the same queries and keeps their lineage
  const src = o.source && o.source.data !== undefined ? o.source.data : o.data
  const data = src && typeof src === 'object' && !Array.isArray(src) ? { ...src, full: true } : { map: src, full: true }
  return {
    object: {
      name,
      title: o.title || 'map',
      question: o.question,
      verb: 'map',
      of: ref(o),
      program: o.program || PROGRAM,
      data,
      hints: ['trace', 'map'],
      declared: { made_by: 'the map verb', from: ref(o), why: 'the full map of a mini map' },
    },
    text: `The full map of ${o.title || o.id}: every station, its lanes split by the lens. Tab selects a station or a lane; its rows show below it.`,
    note: `The person opened the full map of ${ref(o)}. It is the same spec with full: true.`,
  }
}

/** A map of the threads through one station or lane of a map. */
function zoom(ctx, o) {
  const meta = ctx.regionMeta || {}
  const keep = threadsOf(meta)
  const label = String(meta.label || ctx.region).replace(/ · .*$/, '')
  const data = { ...filterThreads(o.data, keep), full: true }
  data.title = `${o.data?.title || o.title || 'map'} ▸ ${label}`
  const one = keep.length === 1
  return {
    object: {
      name: `${slugOf(o.id)}-${String(ctx.region).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 40)}`,
      title: data.title,
      verb: 'map',
      of: ref(o),
      program: o.program || PROGRAM,
      data,
      hints: ['trace', 'map'],
      declared: { made_by: 'the map verb', from: ref(o), region: ctx.region, threads: keep.slice(0, 400), why: one ? `the line of ${keep[0]}` : `the ${keep.length} threads through ${label}` },
    },
    text: one ? `${keep[0]} on its own: its stations in order, each with its rows.` : `The ${keep.length} threads through ${label}, on a map of their own.`,
    note: `The person zoomed ${ref(o)} into ${ctx.region} (${label}): ${keep.length} thread${one ? '' : 's'}${keep.length <= 12 ? ': ' + keep.join(', ') : ''}.`,
  }
}

/** What Claude is asked when the person presses m on something that is not a map. */
export function askFor(o, region) {
  const what = o ? `${o.id}${o.version != null ? '@' + o.version : ''} "${o.title || ''}"` : 'this'
  const part = region ? `, the part ${region}` : ''
  return `Map ${what}${part}: lay out the work behind it by its own structure, as the map skill says. Start from the rows its lineage names (lean list ${o ? o.id : ''}).`
}

export async function run(ctx) {
  const o = ctx.object
  if (!o) return { text: 'Map works on an object. Ask Claude to map the work in words, or open an object first.' }
  if (isMap(o)) {
    if (ctx.region && threadsOf(ctx.regionMeta).length) return zoom(ctx, o)
    if (!o.data?.full) return fullMap(ctx, o)
    if (ctx.region) return { text: `${ctx.regionMeta?.label || ctx.region}: its rows are in the detail view. A station or a lane with threads maps on its own with m.` }
    return { text: 'This is the full map. Select a station or a lane (tab) and press m to map only the threads through it, or ask Claude for another lens in words.' }
  }
  return {
    ask: askFor(o, ctx.region),
    text: `Asked Claude to map ${o.title || o.id}.`,
    note: `The person pressed m on ${ref(o)}${ctx.region ? ' ▸ ' + ctx.region : ''}.`,
  }
}
