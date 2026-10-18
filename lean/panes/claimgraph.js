// claimgraph.js: the Claims graph in cells, as pure functions. No `$`, no DOM: the Claims pane (claims.js) draws what it
// returns as its program (on both surfaces), and the tests read it.
//
//   layout(claims, clusters, {w, h})   a force layout (repulsion, a pull to each cluster's anchor) computed in cells
//                                      of about 1:2, then snapped to cells so no two claims touch: {pos, names}
//   neighbours(view, id)               the claims a claim links to: the claim it revised or that revised it, the
//                                      claims said just before and after it in the same message, those that share a
//                                      source; each with its kind ('revised' or 'link')
//   cardLines(claim, width)            what the claim means, in at most five lines: ● the claim as said, precisely,
//                                      based on (a cite; a sparkline when its source is one), judgment, not stated
//   compose(o)                         the grid of cells: dots in their cluster's color (heavier at ×N ≥ 2, ○ for a
//                                      revised claim, a faint ? beside a claim whose denominator or window was not
//                                      stated), the clusters' names dim at their centres, and, only around the hovered
//                                      claim, its links as thin glyph lines and its card in a thin frame; every other
//                                      claim fades. While a replay grows the graph, its newest claims are marked and
//                                      their links drawn. Rows of runs {s, style, node?}.
import { sparkChars } from '../shell/message.js'

const hash = s => {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

/** Cells of the graph for each claim and each cluster's name, filling w × h. Deterministic for the same input. */
export function layout(claims, clusters, { w, h }) {
  const W = Math.max(20, w)
  const H = Math.max(6, h)
  const used = clusters.filter(c => claims.some(n => n.cluster === c.id))
  const m = Math.max(1, used.length)
  // the clusters' anchors on an ellipse that fills the area (a cell is about twice as tall as wide: y counts double)
  const cx = W / 2, cy = H, rx = W * 0.36, ry = H * 0.74
  const anchor = new Map()
  used.forEach((c, i) => {
    const a = -Math.PI / 2 + (i / m) * Math.PI * 2 + (m % 2 ? 0 : Math.PI / m)
    anchor.set(c.id, m === 1 ? [cx, cy] : [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
  })
  const P = claims.map(n => {
    const [ax, ay] = anchor.get(n.cluster) || [cx, cy]
    return { id: n.id, cluster: n.cluster, x: ax + (hash(n.id) - 0.5) * 12, y: ay + (hash(n.id + '#') - 0.5) * 8, vx: 0, vy: 0 }
  })
  // repulsion only at short range (a collision with room), so each cluster stays an island around its anchor
  for (let it = 0; it < 260; it++) {
    const a = 1 - it / 300
    for (let i = 0; i < P.length; i++) {
      const p = P[i]
      for (let j = i + 1; j < P.length; j++) {
        const q = P[j]
        let dx = q.x - p.x, dy = q.y - p.y
        let d2 = dx * dx + dy * dy
        const reach = p.cluster === q.cluster ? 64 : 196
        if (d2 > reach) continue
        if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02 }
        const f = ((p.cluster === q.cluster ? 7 : 14) * a) / d2
        p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f
      }
      const [ax, ay] = anchor.get(p.cluster) || [cx, cy]
      p.vx += (ax - p.x) * 0.05 * a
      p.vy += (ay - p.y) * 0.05 * a
    }
    for (const p of P) {
      p.vx *= 0.6; p.vy *= 0.6
      p.x = Math.max(2, Math.min(W - 3, p.x + Math.max(-3, Math.min(3, p.vx))))
      p.y = Math.max(2, Math.min(2 * H - 3, p.y + Math.max(-3, Math.min(3, p.vy))))
    }
  }
  // snapped to cells, in the order said: no two claims on the same row within 3 cells, nor in the cells above and below
  const pos = new Map()
  const taken = []
  const free = (x, y) => x >= 1 && x <= W - 2 && y >= 0 && y <= H - 1 && !taken.some(t => (t.y === y && Math.abs(t.x - x) < 4) || (Math.abs(t.y - y) === 1 && Math.abs(t.x - x) < 2))
  for (const p of P) {
    const x0 = Math.round(p.x), y0 = Math.round(p.y / 2)
    let got = null
    for (let r = 0; r < Math.max(W, H) && !got; r++) {
      for (let dy = -r; dy <= r && !got; dy++) {
        for (const dx of r ? [-r * 2, r * 2, ...Array.from({ length: 4 * r - 1 }, (_, k) => k - 2 * r + 1)] : [0]) {
          if (Math.abs(dy) !== r && Math.abs(dx) !== 2 * r) continue
          if (free(x0 + dx, y0 + dy)) { got = { x: x0 + dx, y: y0 + dy }; break }
        }
      }
    }
    got = got || { x: Math.max(1, Math.min(W - 2, x0)), y: Math.max(0, Math.min(H - 1, y0)) }
    taken.push(got)
    pos.set(p.id, got)
  }
  // each cluster's name at the centre of its claims, on a row where it touches none of them
  const names = []
  for (const c of used) {
    const mine = claims.filter(n => n.cluster === c.id).map(n => pos.get(n.id))
    const mx = mine.reduce((s, p) => s + p.x, 0) / mine.length
    const my = Math.round(mine.reduce((s, p) => s + p.y, 0) / mine.length)
    const name = String(c.name)
    let best = null
    for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
      const y = my + dy
      if (y < 0 || y > H - 1) continue
      const x = Math.max(0, Math.min(W - name.length, Math.round(mx - name.length / 2)))
      const hit = [...pos.values()].some(p => p.y === y && p.x >= x - 1 && p.x <= x + name.length) || names.some(o => o.y === y && x < o.x + o.name.length + 2 && o.x < x + name.length + 2)
      if (!hit) { best = { id: c.id, name, x, y }; break }
    }
    if (best) names.push(best)
  }
  return { pos, names, fine: relax(claims, P, anchor, { W, H, cx, cy }), w: W, h: H }
}

/** The claims between cells (x in cells, y in rows), for a surface that draws there (the browser): the same islands,
 *  relaxed from the cells' layout with each claim's links inside its cluster as springs, so related claims sit
 *  together and a cluster reads as a group rather than a lattice. Deterministic. */
function relax(claims, P, anchor, { W, H, cx, cy }) {
  const Q = P.map(p => ({ id: p.id, cluster: p.cluster, x: p.x, y: p.y, vx: 0, vy: 0 }))
  const at = new Map(Q.map((q, i) => [q.id, i]))
  const springs = []
  for (const c of claims) {
    const i = at.get(c.id)
    for (const [id] of neighbours(claims, c.id)) {
      const j = at.get(id)
      if (j != null && i < j && Q[i].cluster === Q[j].cluster) springs.push([i, j])
    }
  }
  for (let it = 0; it < 240; it++) {
    const a = 1 - it / 260
    for (let i = 0; i < Q.length; i++) {
      const p = Q[i]
      for (let j = i + 1; j < Q.length; j++) {
        const q = Q[j]
        let dx = q.x - p.x, dy = q.y - p.y
        let d2 = dx * dx + dy * dy
        const reach = p.cluster === q.cluster ? 42 : 160
        if (d2 > reach) continue
        if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02 }
        const f = ((p.cluster === q.cluster ? 3.2 : 12) * a) / d2
        p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f
      }
      const [ax, ay] = anchor.get(p.cluster) || [cx, cy]
      p.vx += (ax - p.x) * 0.03 * a
      p.vy += (ay - p.y) * 0.03 * a
    }
    for (const [i, j] of springs) {
      const p = Q[i], q = Q[j]
      const dx = q.x - p.x, dy = q.y - p.y
      const d = Math.max(0.1, Math.hypot(dx, dy))
      const f = ((d - 6) * 0.06 * a) / d
      p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f
    }
    for (const p of Q) {
      p.vx *= 0.6; p.vy *= 0.6
      p.x = Math.max(2, Math.min(W - 3, p.x + Math.max(-2, Math.min(2, p.vx))))
      p.y = Math.max(2, Math.min(2 * H - 3, p.y + Math.max(-2, Math.min(2, p.vy))))
    }
  }
  return new Map(Q.map(p => [p.id, { x: Math.round(p.x * 100) / 100, y: Math.round((p.y / 2) * 100) / 100 }]))
}

/** Each cluster's name over its claims at their fine positions: centred on them, on the first row above (else below)
 *  where the words cross no claim and no other name. `len` is a name's width in cells. [{id, name, n, x, y, w}], x the
 *  left cell. */
export function namesOver(claims, clusters, fine, { w, h, len = s => s.length }) {
  const out = []
  const dots = claims.map(c => fine.get(c.id)).filter(Boolean)
  for (const cl of clusters) {
    const mine = claims.filter(c => c.cluster === cl.id).map(c => fine.get(c.id)).filter(Boolean)
    if (!mine.length) continue
    const name = String(cl.name)
    const words = `${name} ${mine.length}`
    const nw = Math.ceil(len(words))
    const mx = mine.reduce((a, p) => a + p.x, 0) / mine.length
    const top = Math.min(...mine.map(p => p.y)), bottom = Math.max(...mine.map(p => p.y))
    const x = Math.max(0, Math.min(w - nw, Math.round(mx - nw / 2)))
    const rows = [Math.floor(top - 1.3), Math.floor(top - 2.3), Math.ceil(bottom + 1.3), Math.ceil(bottom + 2.3), Math.floor(top - 3.3)]
    const clear = y => y >= 0 && y <= h - 1 && !dots.some(p => Math.abs(p.y - (y + 0.5)) < 1 && p.x >= x - 1 && p.x <= x + nw + 1) &&
      !out.some(o => o.y === y && x < o.x + o.w + 2 && o.x < x + nw + 2)
    const y = rows.find(clear)
    if (y != null) out.push({ id: cl.id, name, n: mine.length, x, y, w: nw })
  }
  return out
}

/** Where the card of the claim at `p` goes (cells, for a surface that draws between them): of the places around the
 *  claim (beside it, over it, under it), the one that covers least, the claim's linked claims and links most, then the
 *  nearest. `dots` [{x, y, near}], `near` the linked claims' points, `names` [{x, y, w}]. {x, y, w, h} or null. */
export function cardSpot(p, { bw, bh }, { w, h, dots = [], near = [], names = [] }) {
  const xs = [p.x + 2, p.x - bw / 2, p.x - 3, p.x - bw + 3, p.x - 1 - bw, w - bw, 0]
  const ys = [p.y - 1, p.y + 1.5, p.y + 2.5, p.y + 3.5, p.y - bh - 0.5, p.y - bh - 1.5, p.y - bh / 2, p.y - bh + 2]
  const inside = (q, r) => q.x >= r.x - 0.5 && q.x <= r.x + r.w - 0.5 && q.y >= r.y - 0.5 && q.y <= r.y + r.h - 0.5
  let best = null
  for (const x0 of xs) {
    for (const y0 of ys) {
      const x = Math.max(0, Math.min(w - bw, Math.round(x0))), y = Math.round(y0)
      if (y < 0 || y + bh > h) continue
      const r = { x, y, w: bw, h: bh }
      if (inside(p, r)) continue
      let cost = 0.04 * Math.hypot(x + bw / 2 - p.x, (y + bh / 2 - p.y) * 2.4)
      for (const d of dots) if (inside(d, r)) cost += d.near ? 20 : 0.6
      for (const n of names) if (n.y >= y && n.y < y + bh && n.x < x + bw && x < n.x + n.w) cost += 0.5
      // a link covered costs by how much of it the card hides
      for (const q of near) for (let t = 0.15; t < 0.9; t += 0.15) if (inside({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }, r)) cost += 3
      if (!best || cost < best.cost) best = { ...r, cost }
    }
  }
  return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null
}

/** The claims a claim links to, each once: the revision it is part of, the claims said just before and after it in
 *  the same message, and those that share a source with it (at most six in all). */
export function neighbours(flat, id) {
  const c = flat.find(x => x.id === id)
  if (!c) return new Map()
  const out = new Map()
  if (c.revised_by) out.set(c.revised_by, 'revised')
  if (c.revises) out.set(c.revises, 'revised')
  const row = c.said?.[0]?.row
  if (row) {
    const same = flat.filter(x => x.said?.[0]?.row === row).sort((a, b) => (a.said[0].start ?? 0) - (b.said[0].start ?? 0))
    const k = same.findIndex(x => x.id === id)
    for (const x of [same[k - 1], same[k + 1]]) if (x && !out.has(x.id)) out.set(x.id, 'link')
  }
  const refs = new Set((c.sources || []).map(s => s.ref))
  for (const x of flat) {
    if (out.size >= 6) break
    if (x.id !== id && !out.has(x.id) && (x.sources || []).some(s => refs.has(s.ref))) out.set(x.id, 'link')
  }
  out.delete(id)
  return out
}

/** The cells a straight line from a to b passes through, ends left out, each with its glyph. */
export function line(a, b) {
  const out = []
  let x = a.x, y = a.y
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1
  let err = dx - dy
  for (;;) {
    if (x === b.x && y === b.y) break
    const e2 = 2 * err
    let mx = 0, my = 0
    if (e2 > -dy) { err -= dy; x += sx; mx = sx }
    if (e2 < dx) { err += dx; y += sy; my = sy }
    if (x === b.x && y === b.y) break
    out.push({ x, y, ch: my === 0 ? '─' : mx === 0 ? '│' : mx === my ? '╲' : '╱' })
  }
  return out
}

/** Words wrapped to lines of at most n characters (a word longer than n is cut). */
export function wrap(text, n) {
  const out = []
  let cur = ''
  for (const w of String(text || '').replace(/\s+/g, ' ').trim().split(' ')) {
    if (!w) continue
    const word = w.length > n ? w.slice(0, n - 1) + '…' : w
    if (!cur) cur = word
    else if (cur.length + 1 + word.length <= n) cur += ' ' + word
    else { out.push(cur); cur = word }
  }
  if (cur) out.push(cur)
  return out
}
const cut = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + '…')
export const LABEL = 12

/** How a claim's sources read when the fork gave no Based on: each source as a person reads its ref. */
const sourcesWords = c => (c.sources || []).slice(0, 3).map(x => {
  const r = String(x.ref || '')
  const q = /^(q\d+)(?:#(.*))?$/.exec(r)
  if (q) { let w = q[2] || ''; try { w = decodeURIComponent(w) } catch { /* as written */ } return [q[1], w.replace(/&/g, ' ').replace('@', ' · ')].filter(Boolean).join(' · ') }
  const [path, loc] = r.split('#')
  const line = /^L(\d+)/.exec(loc || '')
  return `${path.split('/').pop()}${line ? ':' + line[1] : ''}`
}).join(', ')

/**
 * What a claim means, as the card under the pointer shows it: at most five lines, each [{s, style}]. ● and the claim as
 * said (bold); precisely; based on (a cite; a sparkline when a source holds its values); judgment and not stated only
 * when the fork gave them. The claim and precisely wrap to two lines while the card has room.
 */
export function cardLines(c, width, { cite = null, amber = null, color = null } = {}) {
  const W = Math.max(30, width)
  const body = W - LABEL
  const based = c.based_on || sourcesWords(c)
  const values = (c.sources || []).find(x => Array.isArray(x.values) && x.values.length > 1)?.values
  const spark = values ? sparkChars(values, 16) : ''
  const parts = [
    { key: 'claim', lines: wrap(c.text, W - 2), style: { bold: true } },
    c.precisely ? { key: 'precisely', label: 'precisely', lines: wrap(c.precisely, body), style: {} } : null,
    based || spark ? { key: 'based', label: 'based on', lines: [cut(String(based || ''), body - (spark ? spark.length + 1 : 0))], style: cite ? { color: cite, underline: true } : { underline: true }, spark } : null,
    c.judgment ? { key: 'judgment', label: 'judgment', lines: wrap(c.judgment, body), style: {} } : null,
    c.unstated ? { key: 'unstated', label: 'not stated', lines: wrap(c.unstated, body), style: {}, labelStyle: amber ? { color: amber } : { dim: true } } : null,
  ].filter(Boolean)
  // one line each for the parts that come after Precisely; the claim and Precisely take two while there is room
  for (const p of parts) if (!['claim', 'precisely'].includes(p.key) && p.lines.length > 1) p.lines = [cut(p.lines.join(' '), body)]
  const total = () => parts.reduce((n, p) => n + Math.min(2, p.lines.length), 0)
  for (const key of ['claim', 'precisely']) {
    const p = parts.find(x => x.key === key)
    if (p && p.lines.length > 2) p.lines = [p.lines[0], cut(p.lines.slice(1).join(' '), p.label ? body : W - 2)]
  }
  for (const key of ['claim', 'precisely']) {
    const p = parts.find(x => x.key === key)
    if (p && total() > 5 && p.lines.length > 1) p.lines = [cut(p.lines.join(' '), p.label ? body : W - 2)]
  }
  const out = []
  for (const p of parts) {
    p.lines.forEach((t, i) => {
      const runs = []
      if (p.key === 'claim') runs.push({ s: i ? '  ' : '● ', style: color ? { color } : {} })
      if (p.label) runs.push({ s: (i ? '' : p.label).padEnd(LABEL), style: p.labelStyle || { dim: true } })
      runs.push({ s: t, style: p.style })
      if (p.spark && i === 0) runs.push({ s: (t ? ' ' : '') + p.spark, style: cite ? { color: cite } : {} })
      out.push(runs)
    })
  }
  return out.slice(0, 5)
}

/**
 * The grid: rows of runs {s, style, node?}. o = {claims (the view's flat list, each with cluster, n, revised_by, text
 * and what it means), clusters, lay (layout's result), visible (the ids shown while a replay grows the graph; null:
 * all), newest (ids the replay just added: marked, with their links), focus (the claim hovered), colorOf (claim →
 * color), amber (the revision color), cite (the based-on color)}.
 */
export function compose(o) {
  const W = o.lay.w, H = o.lay.h
  const cells = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ', style: null })))
  const set = (x, y, ch, style, extra = {}) => { if (y >= 0 && y < H && x >= 0 && x < W) cells[y][x] = { ch, style, ...extra } }
  const shown = o.claims.filter(c => !o.visible || o.visible.has(c.id))
  const byId = new Map(o.claims.map(c => [c.id, c]))
  const ringOn = !!o.focus && byId.has(o.focus) && (!o.visible || o.visible.has(o.focus))
  const near = ringOn ? neighbours(o.claims, o.focus) : new Map()
  const lit = id => !ringOn || id === o.focus || near.has(id)
  // the clusters' names, dim, where their claims are
  for (const n of o.lay.names) {
    if (!shown.some(c => c.cluster === n.id)) continue
    const fade = ringOn && byId.get(o.focus)?.cluster !== n.id
    for (let i = 0; i < n.name.length; i++) set(n.x + i, n.y, n.name[i], { dim: true, faint: !!fade }, { name: true })
  }
  // links as thin lines, a revision dashed in a faint amber: the hovered claim's, or those of a replay's newest claims
  const newest = o.newest || new Set()
  const drawLinks = (from, links) => {
    const a = o.lay.pos.get(from)
    for (const [id, kind] of links) {
      if (o.visible && !o.visible.has(id)) continue
      const b = o.lay.pos.get(id)
      if (!a || !b) continue
      line(a, b).forEach((p, i) => {
        const cur = cells[p.y]?.[p.x]
        if (!cur || cur.name || cur.node || (cur.ch !== ' ' && !cur.edge)) return
        if (Math.abs(p.x - a.x) <= 1 && p.y === a.y) return
        if (kind === 'revised') { if (i % 2) return; set(p.x, p.y, p.ch === '─' ? '╌' : p.ch === '│' ? '╎' : p.ch, { color: o.amber, faint: true }, { edge: true }) }
        else set(p.x, p.y, p.ch, { dim: true }, { edge: true })
      })
    }
  }
  if (ringOn && near.size) drawLinks(o.focus, near)
  else for (const id of newest) drawLinks(id, neighbours(o.claims, id))
  // the claims; a claim whose denominator or window was not stated has a faint ? beside it
  for (const c of shown) {
    const p = o.lay.pos.get(c.id)
    if (!p) continue
    const revised = !!c.revised_by && (!o.visible || o.visible.has(c.revised_by))
    const style = { color: o.colorOf(c), bold: c.n >= 2 || newest.has(c.id), faint: !lit(c.id), ...(newest.has(c.id) ? { mark: true } : {}) }
    // a claim said twice or more is drawn heavier
    set(p.x, p.y, revised ? '○' : c.n >= 2 ? '◉' : '●', style, { node: c.id })
    if (c.unstated && (cells[p.y]?.[p.x + 1]?.ch === ' ' || cells[p.y]?.[p.x + 1]?.edge)) set(p.x + 1, p.y, '?', { color: o.colorOf(c), faint: true }, { mark: true })
  }
  // the hovered claim's card in a thin frame, where it covers the fewest of its links
  let card = null
  if (ringOn) {
    const c0 = byId.get(o.focus)
    const lines = cardLines(c0, Math.min(W - 8, 100), { cite: o.cite, amber: o.amber, color: o.colorOf(c0) })
    const inner = Math.max(...lines.map(l => l.reduce((n, r) => n + r.s.length, 0)))
    const bw = inner + 4, bh = lines.length + 2
    const p = o.lay.pos.get(o.focus)
    const clampX = x => Math.max(0, Math.min(W - bw, x))
    // beside it on the right (its first line level with the dot), else under or over it starting near it, else on its
    // left: each try costs what it covers, its links most
    const tries = [
      [p.x + 2, p.y - 1, 0, true], [p.x + 2, p.y - bh + 2, 0.1, true], [p.x - 2, p.y + 1, 0.2], [p.x - 2, p.y - bh, 0.4],
      [p.x - bw + 3, p.y + 1, 0.6], [p.x - bw + 3, p.y - bh, 0.8], [p.x - 1 - bw, p.y - 1, 1.5, true], [p.x - 1 - bw, p.y - bh + 2, 1.6, true],
    ]
    let best = null
    for (const [x0, y0, pen, beside] of tries) {
      const x = clampX(x0)
      if (y0 < 0 || y0 + bh > H) continue
      if (p.x >= x && p.x < x + bw && p.y >= y0 && p.y < y0 + bh) continue
      if (beside && x !== x0) continue
      let cost = pen
      for (let y = y0; y < y0 + bh; y++) {
        for (let xx = x; xx < x + bw; xx++) {
          const cell = cells[y]?.[xx]
          if (!cell) continue
          if (cell.node) cost += near.has(cell.node) ? 20 : 0.3
          else if (cell.edge) cost += 3
          else if (cell.name || cell.mark) cost += 0.1
        }
      }
      if (!best || cost < best.cost) best = { x, y: y0, cost }
      if (cost === 0) break
    }
    if (best) {
      // a dot under the card keeps its press, drawn as the card's character there: the presses stay the same ones in
      // the same order whatever the card covers, so a focus ring kept by place stays on its claim
      const put = (x, y, ch, style) => set(x, y, ch, style, { card: true, ...(cells[y]?.[x]?.node ? { node: cells[y][x].node } : {}) })
      const frame = { dim: true }
      for (let y = best.y; y < best.y + bh; y++) {
        for (let xx = best.x; xx < best.x + bw; xx++) {
          const top = y === best.y, bottom = y === best.y + bh - 1, left = xx === best.x, right = xx === best.x + bw - 1
          const ch = top ? (left ? '┌' : right ? '┐' : '─') : bottom ? (left ? '└' : right ? '┘' : '─') : left || right ? '│' : ' '
          put(xx, y, ch, ch === ' ' ? null : frame)
        }
      }
      lines.forEach((runs, i) => {
        let x = best.x + 2
        for (const r of runs) for (const ch of r.s) { put(x, best.y + 1 + i, ch, r.style); x++ }
      })
      card = { x: best.x, y: best.y, w: bw, h: bh }
    }
  }
  // rows of runs: a claim's cell a run of its own (a press), the rest merged by style
  const rows = cells.map(row => {
    const runs = []
    for (const cell of row) {
      const key = JSON.stringify(cell.style)
      const last = runs[runs.length - 1]
      if (!cell.node && last && !last.node && last.key === key) last.s += cell.ch
      else runs.push({ s: cell.ch, style: cell.style, key, ...(cell.node ? { node: cell.node } : {}) })
    }
    return runs.map(({ key, ...r }) => r)
  })
  rows.card = card
  return rows
}
