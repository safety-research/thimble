// Explore (x): turn an object or a reply into a view the person can explore, with the real rows one key below.
//
// Who writes the view: Claude, in the main conversation, guided by SKILL.md, saving it with `lean save`. This module
// writes no program and calls no model. When the person presses x on something that has no explorable view yet,
// run() answers with an `ask` that asks Claude to write one; the shell submits it as a turn, drawn as one line. When
// the object already is explorable (it has a knob, or parts that lead to rows), run() opens it at once. A view that
// fails to draw goes back to Claude as a `note`, read with its next prompt: no turn and no row of its own.
//
// Why Claude in the main conversation and not a quiet model call:
//   - every mark must lead to real rows, and a view often needs a grain the reply never computed (per day and wiki,
//     per step); Claude can run `lean q`, which keeps the rows behind each value, and a tool-less call cannot;
//   - follow-ups ("only links", "split by wiki") need the model in the loop: Claude changes the program and saves a
//     new version, so no follow-up is a scripted phrase;
//   - the queries and the save are Bash calls, so Manual mode stays manual and the person sees what ran;
//   - one writer: the model that wrote the reply knows which sentence claims what.
// The cost: x on a plain reply starts a visible turn, about half a minute. x on an explorable object costs nothing.
//
// The module is plain JavaScript with no Node and no `$`: the shell hands in what it needs (shell/node/verb.mjs).
//
//   ctx = {
//     object,   the object as the kernel keeps it (thimble/objects/<id>.json), or null for a bare reply
//     reply,    { text } of the reply the person pressed x on, when there is no object
//     region,   the selected region id, or null
//     state,    the knobs' values the person set, { id: value }
//     w, h,     the room the view has, in cells
//     kernel,   { resolve(ref, n) -> `lean resolve REF --json`, objects() -> [object],
//                 rows(ref, { n, fields }) -> [{ ref, value }] as `lean rows REF --fields` reads them (optional) }
//     draw,     { runProgram(object, { w, h, state }) -> drawing (sandboxed) }
//     verb,     this verb's verb.json with `dir`, its folder: the request names its SKILL.md there
//     open,     true: open any object that has a program as it is, even one that is not an explore view
//     check,    a command that draws a saved view as text, for Claude to check what it made (default
//               `lean verb explore --text`)
//   }
//   run(ctx) -> { object?, view?, text?, note?, ask? }
//     object  the object to show, as {id, version}: an explore object Claude wrote earlier
//     view    { object, drawing, state, region, rows? }: the object drawn, its drawing, the knobs' values, the
//             selection and the rows it opened
//     text    one line for the person
//     note    words for Claude alone (a view that failed to draw)
//     ask     a request to Claude: the shell submits it as a turn
//
// The host's keys go through press(view, key, ctx), which turns knobs, moves the selection and opens rows.
import { knobOf, turn } from '../../draw/handoff.js'
import { nextRegion, renderTerm } from '../../draw/term.js'

const ROWS = 5

// ---------------------------------------------------------------- what can open now

/** Whether a drawing can be explored as it is: a knob to turn, or a part whose rows the kernel can find. */
export function explorable(drawing) {
  if (!drawing || drawing.error) return false
  if ((drawing.controls || []).length) return true
  return (drawing.regions || []).some(r => refsOf(drawing, r.meta || {}).length > 0)
}

/** The explore object Claude wrote for `object` (one with `of` naming it), the newest first. */
export function explorationOf(objects, object) {
  if (!object) return null
  const mine = (objects || []).filter(o => o && o.of && (o.of === object.id || o.of === bare(object.id)))
  mine.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
  return mine[0] || null
}
const bare = id => String(id || '').replace(/^\d+-/, '')
const isExplore = o => !!o && (o.verb === 'explore' || /\bk\.knob\s*\(/.test(String(o.program || '')))

// ---------------------------------------------------------------- the verb

export async function run(ctx) {
  const obj = ctx.object || null
  let target = obj
  // an object that is not an explore view: open the one Claude wrote for it, if there is one
  if (obj && !isExplore(obj) && ctx.kernel && (ctx.kernel.objects || ctx.kernel.list)) {
    const ex = explorationOf(await (ctx.kernel.objects ? ctx.kernel.objects() : ctx.kernel.list()), obj)
    if (ex) target = ex
  }
  if (!target || !target.program || (!isExplore(target) && !ctx.open)) {
    return { text: 'Claude is writing a view of this you can explore.', ask: request(ctx) }
  }
  const view = await open(target, ctx)
  const shown = { id: target.id, version: target.version }
  if (view.drawing.error) {
    const e = view.drawing.error
    return { object: shown, view, text: `The view's program failed (${e.name}). Claude reads why with your next prompt.`,
      note: `The explore view ${target.id} failed to draw: ${e.name}: ${e.message}${e.line ? ` (line ${e.line}: ${e.source})` : ''}. Fix its program and save it again under the same name.` }
  }
  if (!explorable(view.drawing)) {
    return { object: shown, view, text: 'Nothing in this view leads to rows yet; Claude is adding them.', ask: request(ctx, target) }
  }
  return { object: shown, view, text: opened(target, view) }
}

/** What the person can do with a view that opened, in the shell's words. */
function opened(target, view) {
  const knobs = (view.drawing.controls || []).map(c => c.label || c.id)
  return `Opened ${target.id}${knobs.length ? `: turn ${knobs.join(', ')}` : ''}; select a part to read its rows.`
}

/** An object drawn with the shell's sandbox: draw.runProgram (or a host's own draw.run). */
async function drawOf(ctx, object, opts) {
  return ctx.draw.runProgram ? ctx.draw.runProgram(object, opts) : ctx.draw.run(object, opts)
}

/** The view of an object at a state: its drawing, the knobs' values, the selection. */
export async function open(object, ctx) {
  const state = Object.assign({}, ctx.state || {})
  const drawing = await drawOf(ctx, object, { w: ctx.w || 100, h: ctx.h || 24, state })
  const view = { object, drawing, state: drawing.state || state, region: ctx.region || null }
  if (view.region && !regionOf(drawing, view.region, ctx.w)) view.region = null
  return view
}

/** The request that asks Claude to write the view. */
export function request(ctx, existing) {
  const obj = existing || ctx.object
  const skill = ctx.verb && ctx.verb.dir ? `${String(ctx.verb.dir).replace(/\/+$/, '')}/SKILL.md` : 'the explore skill'
  const what = obj
    ? `the object ${obj.id}${obj.title ? ` ("${obj.title}")` : ''} (thimble/objects/${obj.id}.json)`
    : ctx.reply && ctx.reply.text ? `your reply that begins "${firstLine(ctx.reply.text)}"` : 'your last reply'
  const name = obj ? `explore-${bare(obj.id)}` : 'explore-<a short name>'
  return [
    `The person pressed x (Explore) on ${what}. Make it a view they can explore: read ${skill} first.`,
    `Reuse the queries you already ran; run a new \`lean q\` only where a mark needs rows you have not kept.`,
    `Save it with \`lean save ${name} --from FILE\`, with "verb": "explore"${obj ? ` and "of": "${obj.id}"` : ''} in the JSON.`,
    `Check that it draws, as the person will see it, with \`${ctx.check || 'lean verb explore --text'} ${name}\`.`,
    `Then say in one line what the person can turn or open. Do not repeat the answer.`,
  ].filter(Boolean).join(' ')
}
const firstLine = s => { const t = String(s).trim().split('\n')[0].replace(/\s+/g, ' '); return t.length > 80 ? t.slice(0, 79) + '…' : t }

// ---------------------------------------------------------------- keys

/**
 * The next view after a key: `left`/`right` turn the selected knob (else the first; with shift, 10 places), `tab`,
 * `down`, `shift+tab`, `up` move the selection through the parts, `enter` opens or closes the rows of the selected
 * part. Rows follow the selection: after a turn, open rows are read again for the part now under the selection.
 */
export async function press(view, key, ctx) {
  const k = String(key || '').toLowerCase()
  const w = ctx.w || 100
  if (k === 'left' || k === 'right' || k === 'shift+left' || k === 'shift+right') {
    const c = view.region && knobOf(view.drawing, view.region) ? view.region : null
    return turnKnob(view, c, (k.endsWith('left') ? -1 : 1) * (k.startsWith('shift') ? 10 : 1), ctx)
  }
  if (k === 'tab' || k === 'down' || k === 'shift+tab' || k === 'up') {
    const grid = renderTerm(view.drawing, { w })
    const region = nextRegion(grid, view.region, k === 'tab' || k === 'down' ? 1 : -1)
    const next = Object.assign({}, view, { region })
    if (view.rows) next.rows = null
    return next
  }
  if (k === 'enter' || k === 'return') {
    if (view.rows) return Object.assign({}, view, { rows: null })
    if (!view.region) {
      const grid = renderTerm(view.drawing, { w })
      const first = grid.regions.find(r => r.rects.length && refsOf(view.drawing, r.meta).length)
      if (!first) return view
      return Object.assign({}, view, { region: first.id, rows: await rowsFor(view.drawing, first.id, ctx.kernel) })
    }
    return Object.assign({}, view, { rows: await rowsFor(view.drawing, view.region, ctx.kernel) })
  }
  return view
}

/**
 * Turn the knob `id` (the first when null) `step` places and draw again. The selection stays where it was, so a
 * click on a knob's arrows does not take it from the part whose rows are open; a part that is gone hands the
 * selection to the part now in its place, and open rows are read again for it.
 */
export async function turnKnob(view, id, step, ctx) {
  const w = ctx.w || 100
  const state = turn(view.drawing, view.state, id, step)
  if (JSON.stringify(state) === JSON.stringify(view.state)) return view
  const before = view.region ? rectOf(view.drawing, view.region, w) : null
  const drawing = await drawOf(ctx, view.object, { w, h: ctx.h || 24, state })
  const next = Object.assign({}, view, { drawing, state: drawing.state || state })
  if (next.region && !regionOf(drawing, next.region, w)) next.region = before ? regionAtRect(drawing, before, w) : null
  if (view.rows) next.rows = next.region && !knobOf(drawing, next.region) ? await rowsFor(drawing, next.region, ctx.kernel) : null
  return next
}

/** The keys this view answers, for the hint row: [[keys, what]]. Only what applies is listed. */
export function keys(view) {
  const out = []
  if (view.drawing.error) return out
  const knobs = view.drawing.controls || []
  if (knobs.length) {
    const sel = view.region && knobOf(view.drawing, view.region)
    out.push(['◂ ▸', (sel || knobs[0]).label])
  }
  const parts = (view.drawing.regions || []).length
  if (parts > 1) out.push(['tab', 'parts'])
  out.push(['↵', view.rows ? 'close rows' : 'rows'])
  return out
}

export function hint(view) {
  return keys(view).map(([k, what]) => `${k} ${what}`).join(' · ')
}

// ---------------------------------------------------------------- rows

/**
 * The real rows behind a part: the refs its meta names (`rows`, `ref`, `_rows`, a cite's query or rows), each read
 * back through the kernel. { id, label, refs, count, records: [{ref, text}], note }
 */
export async function rowsFor(drawing, id, kernel, o = {}) {
  const n = o.n || ROWS
  const r = regionOf(drawing, id, o.w)
  if (!r) return { id, label: id, refs: [], count: 0, records: [], note: `no part ${id} in this view` }
  const meta = r.meta || {}
  if (meta.knob) return { id, label: meta.label || id, refs: [], count: 0, records: [], note: 'a knob: ◂ ▸ turns it' }
  const refs = refsOf(drawing, meta)
  const out = { id, label: meta.label || id, refs, count: 0, records: [] }
  if (!refs.length) {
    const ex = meta.examples && drawing.examples && drawing.examples[meta.examples]
    if (ex && ex.records.length) {
      out.count = ex.total
      out.records = ex.records.slice(0, n).map(x => ({ ref: '', text: typeof x === 'string' ? x : JSON.stringify(x) }))
      out.note = 'examples the view holds; it names no source rows'
    } else out.note = 'this part names no rows'
    return out
  }
  let counted = 0
  for (const ref of refs) {
    const c = countRows(ref)
    if (c != null) { out.count += c; counted++ }
  }
  // the fields a part names (`fields: ['label', 'body']`) are what a person needs to read its rows
  const fields = Array.isArray(meta.fields) && meta.fields.length && kernel.rows ? meta.fields.map(String) : null
  for (const ref of refs) {
    if (out.records.length >= n && counted === refs.length) break
    let got
    try {
      if (fields && countRows(ref) != null) {
        const rows = await kernel.rows(ref, { n: Math.max(1, n - out.records.length), fields })
        got = { records: rows.map(x => ({ ref: x.ref, text: fields.map(f => flat(x.value && x.value[f])).filter(Boolean).join(' · ') })) }
      } else got = await kernel.resolve(ref, Math.max(1, n - out.records.length))
    } catch (e) { out.note = `the kernel could not read ${ref}: ${String(e && e.message || e).slice(0, 200)}`; continue }
    if (got && got.error) out.note = got.error
    if (countRows(ref) == null && got && typeof got.count === 'number') out.count += got.count
    for (const x of (got && got.records) || []) if (out.records.length < n) out.records.push({ ref: x.ref, text: x.text })
  }
  return out
}

const flat = v => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').trim()

/** The kernel refs a part's meta names, in order, without repeats. */
export function refsOf(drawing, meta) {
  const out = []
  const add = v => {
    if (Array.isArray(v)) { v.forEach(add); return }
    if (typeof v === 'string' && looksLikeRef(v) && !out.includes(v)) out.push(v)
  }
  if (!meta) return out
  add(meta.rows); add(meta.ref); add(meta._rows); add(meta.refs)
  const cite = meta.cite && drawing.cites && drawing.cites[meta.cite]
  if (cite) {
    add(cite.ref)
    if (typeof cite.query === 'string' && /^q\d+(#|$)/.test(cite.query)) add(cite.query)
    add((cite.rows || []).filter(x => typeof x === 'string'))
  }
  return out
}

// a source row, a row set, a query value or an object value (kernel/refs.py)
function looksLikeRef(s) {
  return /^q\d+(#.*)?$/.test(s) || /^obj:[A-Za-z0-9_.-]+(#\/.*)?$/.test(s) || /^[^#\s][^#\n]*#\S+$/.test(s)
}

/** How many rows a row set names (`f.jsonl#L4-9,12`, `x.csv#row=1-3`, `x.db#t/1-4`, `x.json#/a/1-3`); null for others. */
export function countRows(ref) {
  const blocks = /#L(\d+(?:-\d+)?\.b\d+(?:-\d+)?(?:,\d+(?:-\d+)?\.b\d+(?:-\d+)?)*)$/.exec(ref)
  if (blocks) {
    // blocks of transcript records: each part's lines times its blocks
    return blocks[1].split(',').reduce((n, part) => {
      const [[a, b], [c, d]] = part.split('.b').map(x => x.split('-').map(Number))
      return n + (Math.abs((b ?? a) - a) + 1) * (Math.abs((d ?? c) - c) + 1)
    }, 0)
  }
  const m = /#(?:L|row=|[A-Za-z_][A-Za-z0-9_]*\/|(?:\/[^/]*)*\/)(\d+(?:-L?\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(ref)
  if (!m || /\.b\d+$/.test(ref)) return null
  return m[1].split(',').reduce((n, part) => {
    const [a, b] = part.replace(/L/g, '').split('-').map(Number)
    return n + (b == null ? 1 : Math.abs(b - a) + 1)
  }, 0)
}

// ---------------------------------------------------------------- regions

function regionOf(drawing, id, w) {
  const r = (drawing.regions || []).find(x => x.id === id)
  if (r) return r
  // a link's target or a knob: only the terminal layout knows them
  const g = renderTerm(drawing, { w: w || drawing.w })
  return g.regions.find(x => x.id === id) || null
}
function rectOf(drawing, id, w) {
  const g = renderTerm(drawing, { w })
  const r = g.regions.find(x => x.id === id)
  return r && r.rects[0] ? r.rects[0] : null
}
function regionAtRect(drawing, q, w) {
  const g = renderTerm(drawing, { w })
  let best = null, area = Infinity
  for (const r of g.regions) for (const s of r.rects) {
    const ox = Math.min(q.x + q.w, s.x + s.w) - Math.max(q.x, s.x), oy = Math.min(q.y + q.h, s.y + s.h) - Math.max(q.y, s.y)
    if (ox > 0 && oy > 0 && s.w * s.h < area) { best = r.id; area = s.w * s.h }
  }
  return best
}
