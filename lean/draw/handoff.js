// handoff.js: what passes between the terminal and the browser when a person moves an object from one to the
// other: which object (its id and version), which region is selected (the id the program gave it), and the width
// the program ran at. Ids come from the program and the kernel, never from a layout, so the selection survives the
// move, a re-render at another width, and a new version of the program that keeps its ids.
//
//   object ref   messages-by-day@2
//   selection    {object: 'messages-by-day', v: 2, region: 'day-06-18', w: 100, state: {split: 'label'}}
//   in a URL     #o=messages-by-day@2&r=day-06-18&w=100&s={"split":"label"}
//   as a command /draw messages-by-day@2 day-06-18 split=label
//
// `state` holds the knobs' values (k.knob): a program run again with the same state draws the same thing.

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,95}$/

/** `id@v`, the object's stable reference. */
export function objectRef(object) {
  return object.v != null ? `${object.id}@${object.v}` : String(object.id)
}

/** {object, v} from 'id@v' (v absent: the latest). */
export function parseRef(ref) {
  const m = /^([^@\s]+)(?:@(\d+))?$/.exec(String(ref || '').trim())
  if (!m || !ID.test(m[1])) return null
  return m[2] ? { object: m[1], v: Number(m[2]) } : { object: m[1] }
}

/** The hash a browser page opens with: #o=<id>@<v>&r=<region>&w=<columns>. */
export function toHash(sel) {
  const p = new URLSearchParams()
  p.set('o', sel.v != null ? `${sel.object}@${sel.v}` : sel.object)
  if (sel.region) p.set('r', sel.region)
  if (sel.w) p.set('w', String(Math.round(sel.w)))
  if (sel.state && Object.keys(sel.state).length) p.set('s', JSON.stringify(sel.state))
  return '#' + p.toString()
}

/** The selection a hash carries, or null; a region id that is not well formed is dropped. */
export function fromHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''))
  const ref = parseRef(p.get('o'))
  if (!ref) return null
  const sel = Object.assign({}, ref)
  const r = p.get('r')
  if (r && ID.test(r)) sel.region = r
  const w = Number(p.get('w'))
  if (w >= 8 && w <= 400) sel.w = w
  const st = p.get('s')
  if (st) { try { const v = JSON.parse(st); if (v && typeof v === 'object' && !Array.isArray(v)) sel.state = v } catch (e) { /* a state that does not parse is dropped */ } }
  return sel
}

/** The slash command that opens the selection in the terminal (the way back from the browser). */
export function toCommand(sel, name = 'draw') {
  const st = Object.entries(sel.state || {}).map(([k, v]) => ` ${k}=${typeof v === 'string' && !/[\s="]/.test(v) ? v : JSON.stringify(v)}`).join('')
  return `/${name} ${sel.v != null ? `${sel.object}@${sel.v}` : sel.object}${sel.region ? ' ' + sel.region : ''}${st}`
}

/** The selection a command's arguments carry: "<id>[@v] [region]". */
export function fromArgs(args) {
  const [ref, ...rest] = String(args || '').trim().match(/(?:[^\s"=]+=)?"(?:[^"\\]|\\.)*"|\S+/g) || []
  const sel = parseRef(ref)
  if (!sel) return null
  for (const tok of rest) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})=(.*)$/.exec(tok)
    if (m) { let v = m[2]; try { v = JSON.parse(v) } catch (e) { /* a bare word */ } (sel.state = sel.state || {})[m[1]] = v }
    else if (!sel.region && ID.test(tok)) sel.region = tok
  }
  return sel
}

/** The knob (k.knob) a drawing holds under `id`, or undefined. */
export function knobOf(drawing, id) {
  return ((drawing && drawing.controls) || []).find(c => c.id === id)
}

/**
 * The state after turning a knob `step` places (1 is ▸, -1 is ◂), stopping at its ends: run the program again with
 * it. `id` defaults to the drawing's first knob. Returns the state unchanged when there is no such knob.
 */
export function turn(drawing, state, id, step) {
  const c = id ? knobOf(drawing, id) : ((drawing && drawing.controls) || [])[0]
  if (!c) return Object.assign({}, state || {})
  const i = Math.max(0, Math.min(c.values.length - 1, c.i + Math.round(step || 0)))
  return Object.assign({}, state || {}, { [c.id]: c.values[i] })
}

// ---------------------------------------------------------------- pages (kit.js: a page knob, every page at once)
// A card drawn with every page of its page knob at once (run's opts.all) gives each page's parts the page's ids:
// `pg3~~day-18` is the part `day-18` as page 3 draws it, `pg3~~` page 3's heading. Outside that drawing a selection is
// the card's own: the part's own id, with the knob at that page.

/** The id of part `id` of page `n` (1-based) in a drawing of every page at once; `id` '' is the page's heading. */
export function pageId(n, id = '') {
  return `pg${n}~~${id ?? ''}`
}

/** A page's id read back: {page, id} (id '' for the heading), or null for any other id. */
export function pageOf(id) {
  const m = /^pg(\d+)~~(.*)$/.exec(String(id ?? ''))
  return m ? { page: Number(m[1]), id: m[2] } : null
}

/** The drawing's page knob (k.knob with pages, or named or formatted as pages), or null. */
export function pageKnob(drawing) {
  return ((drawing && drawing.controls) || []).find(c => c.pages) || null
}

/** The knob a drawing shows all at once (it carries `all`), or null. */
export function allKnob(drawing) {
  return ((drawing && drawing.controls) || []).find(c => c.all) || null
}

/**
 * A part of a drawing of every page at once, as the card's own selection: {region, state} where region is the part's
 * own id (null for a page's heading) and state holds the knob at that page. A part of no page: as it is, no state.
 */
export function ownPart(drawing, id) {
  const p = pageOf(id)
  const c = p ? allKnob(drawing) || pageKnob(drawing) : null
  if (!p || !c || p.page < 1 || p.page > c.values.length) return { region: p ? p.id || null : id ?? null, state: null }
  return { region: p.id || null, state: { [c.id]: c.values[p.page - 1] } }
}

/** The page (1-based) a knob's value is, or 0. */
export function pageAt(control, value) {
  if (!control) return 0
  const i = control.values.findIndex(x => JSON.stringify(x) === JSON.stringify(value))
  return i < 0 ? control.i + 1 : i + 1
}
