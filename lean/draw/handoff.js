// handoff.js: what passes between the terminal and the browser when a person moves an object from one to the
// other: which object (its id and version), which region is selected (the id the program gave it), and the width
// the program ran at. Ids come from the program and the kernel, never from a layout, so the selection survives the
// move, a re-render at another width, and a new version of the program that keeps its ids.
//
//   object ref   messages-by-day@2
//   selection    {object: 'messages-by-day', v: 2, region: 'day-06-18', w: 100}
//   in a URL     #o=messages-by-day@2&r=day-06-18&w=100
//   as a command /draw messages-by-day@2 day-06-18

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
  return sel
}

/** The slash command that opens the selection in the terminal (the way back from the browser). */
export function toCommand(sel, name = 'draw') {
  return `/${name} ${sel.v != null ? `${sel.object}@${sel.v}` : sel.object}${sel.region ? ' ' + sel.region : ''}`
}

/** The selection a command's arguments carry: "<id>[@v] [region]". */
export function fromArgs(args) {
  const [ref, region] = String(args || '').trim().split(/\s+/)
  const sel = parseRef(ref)
  if (!sel) return null
  if (region && ID.test(region)) sel.region = region
  return sel
}
