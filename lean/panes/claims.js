// claims.js: the Claims pane, a program on the card runtime (draw/kit.js) over the session's claims store
// (thimble/claims/<session>.json). The terminal and the browser run this same program on the same store. The hover and
// the replay are each surface's own (k.local): a pointer in the browser never moves the terminal's ring.
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
import { LABEL, cardLines, cardSpot, compose, layout, namesOver, neighbours } from './claimgraph.js'

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
  /** The hover and the replay belong to the surface where they happen: a pointer on one surface never moves the other. */
  local: ['hover', 'replay'],
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
      fine: Object.fromEntries([...lay.fine].map(([id, p]) => [id, p])),
    }
  },
  program,
}

/** The program: the graph as a canvas of cells (a claim a part of its own), with its keys. */
export function program(k, data) {
  k.local('hover', 'replay')
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

  const { visible, newest } = replayShows(replay, order)
  // ---- in the browser the graph is drawn where the layout left each claim, between cells: dots as circles, links as
  // strokes, the card an opaque box over them (the same claims, links and card as the cells below)
  if (k.surface === 'browser' && data.fine) return k.stack(head, k.text(' '), vectorGraph(k, data, { claims, byId, visible, newest, hover, colorOf }))

  // ---- the graph: claimgraph.js lays the cells out (the hovered claim's card over the rest), drawn here as tones
  const lay = { w: data.w, h: data.h, pos: new Map(Object.entries(data.pos)), names: data.names }
  const rows = compose({ claims, clusters: data.groups, lay, visible, newest, focus: hover, colorOf, amber: 'warn', cite: 'accent' })
  const c = k.canvas(data.w, data.h)
  const toneOf = s => {
    if (!s) return 'ink'
    const base = s.color || (s.dim || s.faint ? 'dim' : 'ink')
    return s.faint ? `${base}-faint` : base
  }
  rows.forEach((runs, y) => {
    // runs of one style are one text, even across a claim's cell (a claim under the card keeps its press there): so
    // a proportional face in the browser draws the card's words whole; each claim's cell is a part of its own
    let x = 0
    let cur = null
    const flush = () => {
      if (!cur) return
      if (cur.s.trim()) {
        if (cur.mark) c.bg(cur.x, y, Array.from(cur.s).length, 1, 'warn-faint')
        // lines (the card's frame, a link) stay on their cells, so the browser draws them as strokes there; words are
        // one text each
        let at = cur.x
        for (const piece of cur.s.match(/[─│┌┐└┘╌╎]+|[^─│┌┐└┘╌╎]+/g) || []) {
          const n = Array.from(piece).length
          if (/^─+$/.test(piece)) c.hline(at, y, n, '─', cur.tone)
          else if (/^[─│┌┐└┘╌╎]+$/.test(piece)) Array.from(piece).forEach((ch, i) => c.put(at + i, y, ch, cur.tone))
          else if (piece.trim()) c.text(at, y, piece, { tone: cur.tone, bold: cur.bold, raw: true })
          at += n
        }
      }
      cur = null
    }
    for (const r of runs) {
      const t = toneOf(r.style)
      const bold = !!(r.style && r.style.bold)
      const mark = !!(r.style && r.style.mark)
      // a claim's dot outside the card stands alone (its own glyph, drawn as a dot)
      if (r.node && r.s.trim() && /^[●◉○]$/.test(r.s)) {
        flush()
        if (mark) c.put(x, y, r.s, t, { bold, bg: 'warn-faint' })
        else c.put(x, y, r.s, t, { bold })
      } else if (cur && cur.tone === t && cur.bold === bold && cur.mark === mark) cur.s += r.s
      else { flush(); cur = { x, s: r.s, tone: t, bold, mark } }
      if (r.node) {
        const cl = byId.get(r.node)
        c.region(claimRegion(r.node), x, y, 1, 1, { label: `claim: ${cl ? cl.text : r.node}`, claim: r.node, refs: cl ? cl.sources.map(q => q.ref).filter(Boolean) : [] })
      }
      x += Array.from(r.s).length
    }
    flush()
  })
  return k.stack(head, k.text(' '), c)
}

/** The graph between cells (the browser): the same model as compose's cells, drawn with the canvas's dots and links. */
function vectorGraph(k, data, { claims, byId, visible, newest, hover, colorOf }) {
  const c = k.canvas(data.w, data.h)
  const fine = new Map(Object.entries(data.fine))
  const shown = claims.filter(x => !visible || visible.has(x.id))
  const ringOn = !!hover && (!visible || visible.has(hover))
  const near = ringOn ? neighbours(claims, hover) : new Map()
  const lit = id => !ringOn || id === hover || near.has(id)
  const faint = t => `${t}-faint`
  // the hovered claim's card first, so what it covers is known: its claims lose their presses, their words stay hidden
  let card = null
  let lines = []
  if (ringOn) {
    const c0 = byId.get(hover)
    lines = cardLines(c0, Math.min(data.w - 8, 72), { cite: 'accent', amber: 'warn', color: colorOf(c0) })
    // the browser sets the words in a proportional face, narrower than the cells they count (bold a little wider); a
    // label's column stays cells wide
    const wide = r => r.s.length * (r.style && r.style.bold ? 0.92 : 0.86)
    const inner = Math.max(...lines.map(l => {
      const at = l.findIndex(r => r.s.length === LABEL && /\s$/.test(r.s))
      return at < 0 ? l.reduce((n, r) => n + wide(r), 0) : LABEL + l.slice(at + 1).reduce((n, r) => n + wide(r), 0)
    }))
    const p = fine.get(hover)
    const dots = shown.filter(x => x.id !== hover).map(x => ({ ...fine.get(x.id), near: near.has(x.id) })).filter(d => d.x != null)
    const names = namesOver(shown, data.groups || [], fine, { w: data.w, h: data.h, len: t => k.len(t) * 0.86 })
    if (p) card = cardSpot(p, { bw: Math.ceil(inner) + 4, bh: lines.length + 2 }, { w: data.w, h: data.h, dots, names, near: [...near.keys()].map(id => fine.get(id)).filter(Boolean) })
  }
  const under = q => !!card && q.x >= card.x && q.x <= card.x + card.w - 1 && q.y >= card.y && q.y <= card.y + card.h - 1
  // the clusters' names over their claims, with how many
  const hoverCluster = ringOn ? byId.get(hover)?.cluster : null
  for (const nm of namesOver(shown, data.groups || [], fine, { w: data.w, h: data.h, len: t => k.len(t) * 0.86 })) {
    if (card && nm.y >= card.y && nm.y < card.y + card.h && nm.x < card.x + card.w && card.x < nm.x + nm.w) continue
    const fade = ringOn && String(hoverCluster) !== String(nm.id)
    c.text(nm.x, nm.y, `{${fade ? 'dim-faint' : 'ink'}:${k.escape(nm.name)}} {${fade ? 'dim-faint' : 'dim'}:${nm.n}}`)
  }
  // the links: the hovered claim's, or those of a replay's newest claims; a revision dashed in amber
  const links = (from, list) => {
    const a = fine.get(from)
    for (const [id, kind] of list) {
      if (visible && !visible.has(id)) continue
      const b = fine.get(id)
      if (a && b) c.link(a.x, a.y, b.x, b.y, kind === 'revised' ? 'warn' : 'dim', { dash: kind === 'revised' })
    }
  }
  if (ringOn && near.size) links(hover, near)
  else for (const id of newest) links(id, neighbours(claims, id))
  // the claims: heavier when said twice or more (with ×N), hollow once revised, a faint ? when a denominator or window
  // was not stated; a replay's newest marked
  for (const x of shown) {
    const p = fine.get(x.id)
    if (!p) continue
    const hidden = under(p) && x.id !== hover
    const revised = !!x.revised_by && (!visible || visible.has(x.revised_by))
    const tone = lit(x.id) ? colorOf(x) : faint(colorOf(x))
    const label = hidden ? '' : [x.n >= 2 ? `×${x.n}` : '', x.unstated ? '?' : ''].filter(Boolean).join(' ')
    c.dot(p.x, p.y, tone, {
      size: x.n >= 2 || x.id === hover ? 2 : 1, hollow: revised, bold: newest.has(x.id), ...(newest.has(x.id) ? { bg: 'warn-faint' } : {}),
      ...(label ? { label, labelTone: lit(x.id) ? 'dim' : 'dim-faint' } : {}),
      ...(hidden ? {} : { part: claimRegion(x.id), meta: { label: `claim: ${x.text}`, claim: x.id, refs: x.sources.map(q => q.ref).filter(Boolean) } }),
    })
  }
  // the card: an opaque box over the graph, its lines as compose writes them
  if (card) {
    c.box(card.x, card.y, card.w, card.h, { fill: true, tone: 'rule' })
    const toneOf = st => (!st ? 'ink' : st.color || (st.dim ? 'dim' : 'ink'))
    const markup = runs => runs.map(r => `{${toneOf(r.style)}:${r.style && r.style.bold ? `**${k.escape(r.s)}**` : k.escape(r.s)}}`).join('')
    lines.forEach((runs, i) => {
      // a label's column is cells wide (the words after it line up); the rest of the line is one text
      const at = runs.findIndex(r => r.s.length === LABEL && /\s$/.test(r.s))
      const y = card.y + 1 + i
      if (at < 0) { c.text(card.x + 2, y, markup(runs), { max: card.w - 3 }); return }
      const label = runs.slice(0, at + 1).map(r => ({ ...r, s: r.s.trimEnd() })).filter(r => r.s)
      if (label.length) c.text(card.x + 2, y, markup(label))
      c.text(card.x + 2 + LABEL, y, markup(runs.slice(at + 1)), { max: card.w - 3 - LABEL })
    })
  }
  return c
}
