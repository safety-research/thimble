// exercise.mjs: a card's interactions tried once, as the person would try them, before they press anything.
//
// At a save the runtime draws the card, then runs each interaction the drawing declares, each as its own run of the
// program from the drawn state: every value of each knob (k.knob), each key and event its handlers take (k.on), a
// press on each part when it takes presses, a brush across the middle of each brush area, and an event a handler
// asks for later (k.after) once, with its payload. The runs are pure: nothing is written, a k.ask opens no thread and
// a k.do is not carried out. What fails comes back as one line for Claude (exerciseLine), so it fixes the card before
// the person meets the error. `node cli.mjs <object.json> --check` prints the same line.
import { runProgram } from './sandbox-node.mjs'

// keys as handlers name them (k.on('space', ...)); any one-character name is a key too
const KEYS = new Set(['space', 'return', 'enter', 'esc', 'escape', 'tab', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end'])
// the most values of one knob tried (spread over its range, both ends kept), and the most parts pressed
const MAX_VALUES = 12
const MAX_PARTS = 24

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
const plainState = s => { const o = { ...(isObj(s) ? s : {}) }; delete o.browser; return o }

/** Up to `n` of a list, spread evenly, its first and last kept. */
function spread(list, n) {
  if (list.length <= n) return list
  const out = []
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))])
  return [...new Set(out)]
}

/** The brush areas a drawing defines: {id, min, max} (a plot's x range, a canvas brush's min and max). */
export function brushAreas(drawing) {
  const out = []
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.t === 'plot' && n.brush) {
      const xs = []
      for (const s of n.series || []) for (const p of s.pts || []) { const x = Array.isArray(p) ? p[0] : isObj(p) ? p.x : null; if (typeof x === 'number' && Number.isFinite(x)) xs.push(x) }
      const min = typeof n.x?.min === 'number' ? n.x.min : xs.length ? Math.min(...xs) : 0
      const max = typeof n.x?.max === 'number' ? n.x.max : xs.length ? Math.max(...xs) : 1
      out.push({ id: n.brush.id, min, max })
    }
    if (n.t === 'canvas') for (const op of n.ops || []) if (Array.isArray(op) && op[0] === 'brush') out.push({ id: op[1], min: op[6], max: op[7] })
    for (const k of Object.keys(n)) if (k !== 'meta' && n[k] && typeof n[k] === 'object') walk(n[k])
  }
  walk(drawing && drawing.root)
  return out
}

/** What a person can do to a drawing, each one try: {what, state} (a knob turned) or {what, event}. */
export function triesOf(drawing, state) {
  const tries = []
  if (!drawing || drawing.error) return tries
  const base = isObj(state) ? state : {}
  for (const c of drawing.controls || []) {
    const others = (c.values || []).map((v, i) => ({ v, i })).filter(x => x.i !== c.i)
    for (const { v, i } of spread(others, MAX_VALUES)) {
      tries.push({ what: `turning ${c.label || c.id} to ${c.shown?.[i] ?? JSON.stringify(v)}`, state: { ...base, [c.id]: v }, change: { [c.id]: v } })
    }
  }
  const regions = (drawing.regions || []).map(r => r.id)
  const names = (drawing.on || []).map(h => ({ name: String(h.name), label: h.label || '' }))
  const said = (h, verb) => `${verb}${h.label ? ` (${h.label})` : ''}`
  for (const h of names) {
    const n = h.name
    let m
    if ((m = /^press:(.+)$/.exec(n))) tries.push({ what: said(h, `pressing ${m[1]}`), event: { type: 'press', region: m[1] } })
    else if (n === 'press') {
      const own = new Set(names.filter(x => x.name.startsWith('press:')).map(x => x.name.slice(6)))
      for (const id of spread(regions.filter(r => !own.has(r)), MAX_PARTS)) tries.push({ what: said(h, `pressing ${id}`), event: { type: 'press', region: id } })
    } else if ((m = /^brush(?::(.+))?$/.exec(n))) {
      const areas = brushAreas(drawing).filter(a => !m[1] || a.id === m[1])
      const list = areas.length ? areas : [{ id: m[1] || 'brush', min: 0, max: 1 }]
      for (const a of list) {
        const span = a.max - a.min
        tries.push({ what: said(h, `brushing ${a.id}`), event: { type: 'brush', id: a.id, from: a.min + span / 4, to: a.min + (span * 3) / 4 } })
      }
    } else if (n.length === 1 || KEYS.has(n)) {
      // the host sends the part selected with a key; the first part stands for it
      tries.push({ what: said(h, `pressing ${n}`), event: { type: 'key', key: n, ...(regions.length ? { region: regions[0] } : {}) } })
    }
    // any other name is an event the host or a k.after sends with its own payload: tried when a handler asks for it
  }
  return tries
}

/**
 * Try a card's interactions once. `opts` are the drawing's own (w, h, mode, state, keys, surface); `drawn` is the
 * drawing already made with them (else it is made here). `budget` is the most milliseconds the tries take: past it
 * the rest are left and `cut` says how many.
 * @returns {{tried: number, total: number, cut: number, ms: number, failed: {what: string, change?: object, event?: object, error: {name: string, message: string, line?: number|null, fix?: string}}[]}}
 */
export function exercise(object, opts = {}, drawn = null, budget = 400) {
  const t0 = performance.now()
  const run = o => runProgram(object, { ...opts, ...o })
  const first = drawn || run({})
  const result = { tried: 0, total: 0, cut: 0, ms: 0, failed: [] }
  if (!first || first.error) return { ...result, ms: Math.round(performance.now() - t0) }
  const state = isObj(opts.state) ? opts.state : {}
  // the same card where the detail draws it may declare more (a program that shows more in the detail)
  const queue = triesOf(first, state)
  const seen = new Set(queue.map(t => t.what))
  if (opts.mode !== 'detail') {
    const wide = { mode: 'detail', h: Math.max(32, Number(opts.h) || 24) }
    const d = run(wide)
    if (d && d.error) result.failed.push({ what: 'drawing it in the detail', error: d.error })
    else if (d) {
      for (const t of triesOf(d, state)) {
        if (seen.has(t.what)) continue
        seen.add(t.what)
        queue.push({ ...t, opts: wide })
      }
    }
  }
  const later = new Set()
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i]
    const left = budget - (performance.now() - t0)
    if (left <= 0) { result.cut = queue.length - i; break }
    const d = run({ ...(t.opts || {}), ...(t.state ? { state: t.state } : { event: t.event }) })
    result.tried++
    if (d.error) {
      result.failed.push({ what: t.what, ...(t.change ? { change: t.change } : {}), ...(t.event ? { event: t.event } : {}), error: d.error })
      continue
    }
    // an event the handler asked for later (a replay's next frame): once, with its payload, from the state it left
    for (const a of d.after || []) {
      const ev = a && a.event
      if (!isObj(ev) || !ev.type || later.has(ev.type)) continue
      later.add(ev.type)
      queue.push({ what: `its later event ${ev.type} (after ${t.what})`, event: ev, state: undefined, opts: { ...(t.opts || {}), state: { ...state, ...plainState(d.state) } } })
    }
  }
  result.total = queue.length
  result.ms = Math.round(performance.now() - t0)
  return result
}

/** The one line Claude reads when a try failed (null when every try ran): what failed first, how to repeat it, how
 *  many more failed and whether the tries were cut. */
export function exerciseLine(r) {
  if (!r || !r.failed.length) return null
  const f = r.failed[0]
  const err = `${f.error.name}: ${String(f.error.message).slice(0, 160)}${f.error.line ? ` (line ${f.error.line})` : ''}`
  const again = f.change ? ` (state ${JSON.stringify(f.change)})` : f.event ? ` (event ${JSON.stringify(f.event)})` : ''
  const other = r.failed.find(x => x.error.message !== f.error.message)
  const same = r.failed.filter(x => x.error.message === f.error.message).length - 1
  const rest = [same ? `${same} more fail${same === 1 ? 's' : ''} the same way` : '', other ? `${other.what} fails with ${other.error.name}: ${String(other.error.message).slice(0, 100)}` : ''].filter(Boolean).join('; ')
  const cut = r.cut ? ` Only ${r.tried} of ${r.total} were tried in time.` : ''
  return `Tried as the person would, ${f.what} fails: ${err}${again}${rest ? `; ${rest}` : ''}.${cut} Fix the program or the data it binds and save it again under the same name now, before the person tries it.`
}
