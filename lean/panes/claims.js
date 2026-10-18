// claims.js: the Claims pane, a program on the card runtime (draw/kit.js) over the session's claims store
// (thimble/claims/<session>.json). The terminal and the browser run this same program on the same store and keep the
// same state, so the graph, its hover and its replay are one thing on both surfaces.
//
// At rest: one island of dots per cluster, its name dim at its centre, no lines. The claim the pointer or the ring is
// on shows a card of what it means beside it (the claim as said, Precisely, Based on, Judgment, Not stated), keeps its
// links bright and draws them as thin lines, and fades the rest. r replays the graph in the order the claims were made,
// "turn 2 of 4" in the head, its newest claims marked with their links; any key stops it.
//
//   state: {hover: claim id | null, replay: {k} | null}
//   events: focus and hover (the ring, the pointer) on a claim; press; r; tick (the replay's next frame, k.after);
//           any key while a replay runs; ↑ ↓ ← → move the hover to the nearest claim that way (the browser; in the
//           terminal the ring moves itself); esc closes
import { madeOrder, viewOf } from '../verbs/claims/claims.js'
import { compose, layout } from './claimgraph.js'

/** The head's rows (its line and a blank row). */
export const HEAD_ROWS = 2
/** A replay lasts about this long, at most a frame per `tick` ms. */
export const REPLAY = { ms: 3200, tick: 80, hold: 600 }
const every = n => Math.max(REPLAY.tick, Math.floor(REPLAY.ms / Math.max(1, n)))
export const claimRegion = id => `cl-${id}`
export const claimOfRegion = r => (/^cl-(.+)$/.exec(String(r || '')) || [])[1] ?? null

/** The claims a replay shows (null: all), and the ones it added last (about a fifth: they are marked, with links). */
export function replayShows(r, order) {
  if (!r) return { visible: null, newest: new Set() }
  const k = Math.min(order.length, r.k || 0)
  const recent = Math.max(1, Math.round(order.length * 0.18))
  return { visible: new Set(order.slice(0, k)), newest: new Set(order.slice(Math.max(0, k - recent), k)) }
}

/** Where a replay is, for the head: "turn 2 of 4" (the turn of the claim it showed last), "the corpus", or "replay". */
export function replayWhere(r, order, flat) {
  const k = Math.min(order.length, r.k || 0)
  const last = k ? flat.find(c => c.id === order[k - 1]) : null
  if (!last) return 'replay'
  if (last.by === 'orientation') return 'the corpus'
  const turns = flat.map(c => c.turn).filter(t => typeof t === 'number')
  return last.turn == null ? 'replay' : `turn ${last.turn} of ${Math.max(...turns)}`
}

const fresh = rec => (Array.isArray(rec?.verbs?.c?.claims) ? rec.verbs.c.claims.map(String) : [])
const slim = c => ({
  id: c.id, text: c.text, cluster: c.cluster ?? null, n: c.n || 1, by: c.by, turn: c.turn ?? null, kind: c.kind,
  ...(c.revised_by ? { revised_by: c.revised_by } : {}), ...(c.revises ? { revises: c.revises } : {}),
  ...(c.precisely ? { precisely: c.precisely } : {}), ...(c.based_on ? { based_on: c.based_on } : {}),
  ...(c.judgment ? { judgment: c.judgment } : {}), ...(c.unstated ? { unstated: c.unstated } : {}),
  sources: (c.sources || []).slice(0, 6).map(s => ({ ref: s.ref, ...(s.label ? { label: s.label } : {}), ...(Array.isArray(s.values) ? { values: s.values.slice(0, 48) } : {}) })),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row, by: s.by, turn: s.turn ?? null, ...(s.start != null ? { start: s.start } : {}) })),
})

export default {
  name: 'claims',
  title: 'Claims',
  /** The stores it reads: the claims, the message it was opened from (its new claims), the order of the messages. */
  reads: args => ['claims', 'index', ...(args && args.row ? [`record:${args.row}`] : [])],
  /** One file of state per session. */
  stateKey: () => 'claims',
  /** The graph laid out for the room the surface gives (w columns, h rows). */
  data(stores, args, size) {
    const store = stores.claims && Array.isArray(stores.claims.claims) ? stores.claims : { claims: [], clusters: [] }
    const view = viewOf({ clusters: [], ...store }, { fresh: fresh(args && args.row ? stores[`record:${args.row}`] : null) })
    const w = Math.max(30, Math.floor(size.w || 100))
    const h = Math.max(6, Math.floor(size.h || 30) - HEAD_ROWS)
    const groups = view.groups.filter(g => g.id != null)
    const flat = view.flat.map(slim)
    const lay = layout(flat, groups, { w, h })
    const order = madeOrder(store, { order: (stores.index || []).map(x => String(x.row)) })
    return {
      w, h, total: view.total, clusters: view.clusters, order, claims: flat,
      groups: groups.map((g, i) => ({ id: g.id, name: g.name, i })),
      pos: Object.fromEntries([...lay.pos].map(([id, p]) => [id, p])), names: lay.names,
    }
  },
  program,
}

/** The program: the graph as a canvas of cells (a claim a part of its own), with its keys. */
export function program(k, data) {
  const st = k.state || {}
  const replay = st.replay && typeof st.replay === 'object' ? st.replay : null
  const claims = data.claims || []
  const byId = new Map(claims.map(c => [c.id, c]))
  const tone = new Map((data.groups || []).map(g => [String(g.id), `c${(g.i % 6) + 1}`]))
  const colorOf = c => tone.get(String(c.cluster)) || 'dim'
  const order = data.order || []
  const hover = replay ? null : (st.hover && byId.has(st.hover) ? st.hover : null)

  // ---- what the person does
  const stop = () => ({ replay: null })
  k.on('r', () => {
    if (replay) return stop()
    if (!order.length) return null
    k.after(every(order.length), 'tick')
    return { replay: { k: 0 }, hover: null }
  }, 'replay')
  k.on('tick', () => {
    if (!replay) return null
    const n = order.length
    if ((replay.k || 0) >= n) return stop()
    const step = Math.max(1, Math.round((n * every(n)) / REPLAY.ms))
    const next = Math.min(n, (replay.k || 0) + step)
    // the last claims stay marked for a moment, then the graph is whole again
    k.after(next >= n ? REPLAY.hold : every(n), 'tick')
    return { replay: { k: next } }
  })
  // any key while a replay runs: the whole graph at once
  if (replay) k.on('key', stop)
  const hoverOn = e => {
    const id = claimOfRegion(e.region)
    return { hover: id && byId.has(id) ? id : null, replay: null }
  }
  k.on('focus', hoverOn)
  k.on('hover', hoverOn)
  k.on('press', e => {
    const id = claimOfRegion(e.region)
    // in the browser a press on the claim already shown opens the message where it was said
    if (k.surface === 'browser' && id && id === hover) {
      const said = (byId.get(id).said || [])[0]
      if (said && said.row) k.do('open', { row: said.row })
      return null
    }
    return hoverOn(e)
  })
  // the arrow keys move the hover to the nearest claim that way (the terminal's ring moves itself and says focus)
  const move = (dx, dy) => () => {
    const from = hover ? data.pos[hover] : null
    let best = null
    for (const c of claims) {
      const p = data.pos[c.id]
      if (!p || c.id === hover) continue
      if (!from) { if (!best || p.y < best.p.y || (p.y === best.p.y && p.x < best.p.x)) best = { id: c.id, p, d: 0 }; continue }
      const ax = (p.x - from.x) / 2, ay = p.y - from.y
      const along = ax * dx + ay * dy
      if (along <= 0) continue
      const d = along + Math.abs(ax * dy) * 2 + Math.abs(ay * dx) * 2
      if (!best || d < best.d) best = { id: c.id, p, d }
    }
    return best ? { hover: best.id, replay: null } : null
  }
  k.on('up', move(0, -1))
  k.on('down', move(0, 1))
  k.on('left', move(-1, 0))
  k.on('right', move(1, 0))
  k.on('esc', () => { k.do('close') }, 'close')

  // ---- the head: "Claims   31 · 5 clusters", or where a replay is
  const where = replay ? replayWhere(replay, order, claims) : `${data.total} · ${data.clusters} cluster${data.clusters === 1 ? '' : 's'}`
  const head = k.text(`{c2:**Claims**}   {dim:${k.escape(where)}}`)
  if (!data.total) return k.stack(head, k.text(' '), k.text('{dim:No claims yet.}'))
  if (!data.pos || !data.names) return k.stack(head, k.text(' '), k.text('{bad:The graph could not be laid out. Press esc, then c to open it again.}'))

  // ---- the graph: claimgraph.js lays the cells out (the hovered claim's card over the rest), drawn here as tones
  const { visible, newest } = replayShows(replay, order)
  const lay = { w: data.w, h: data.h, pos: new Map(Object.entries(data.pos)), names: data.names }
  const rows = compose({ claims, clusters: data.groups, lay, visible, newest, focus: hover, colorOf, amber: 'warn', cite: 'accent' })
  const c = k.canvas(data.w, data.h)
  const toneOf = s => {
    if (!s) return 'ink'
    const base = s.color || (s.dim || s.faint ? 'dim' : 'ink')
    return s.faint ? `${base}-faint` : base
  }
  rows.forEach((runs, y) => {
    let x = 0
    for (const r of runs) {
      const t = toneOf(r.style)
      const bold = !!(r.style && r.style.bold)
      if (r.node) {
        const cl = byId.get(r.node)
        if (r.style && r.style.mark) c.put(x, y, r.s, t, { bold, bg: 'warn-faint' })
        else c.text(x, y, r.s, { tone: t, bold, raw: true })
        c.region(claimRegion(r.node), x, y, 1, 1, { label: `claim: ${cl ? cl.text : r.node}`, claim: r.node, refs: cl ? cl.sources.map(s => s.ref).filter(Boolean) : [] })
      } else if (r.s.trim()) {
        if (r.style && r.style.mark) for (let i = 0; i < r.s.length; i++) c.put(x + i, y, r.s[i], t, { bold, bg: 'warn-faint' })
        else c.text(x, y, r.s, { tone: t, bold, raw: true })
      }
      x += r.s.length
    }
  })
  return k.stack(head, k.text(' '), c)
}
