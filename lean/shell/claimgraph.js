// claimgraph.js: the Claims graph in terminal cells, as pure functions. No `$`, no DOM: the shell draws what it
// returns (claimsview.ts), and the tests read it.
//
//   layout(claims, clusters, {w, h})   a force layout (repulsion, a pull to each cluster's anchor) computed in cells
//                                      of about 1:2, then snapped to cells so no two claims touch: {pos, names}
//   neighbours(view, id)               the claims a claim links to: the claim it revised or that revised it, the
//                                      claims said just before and after it in the same message, those that share a
//                                      source; each with its kind ('revised' or 'link')
//   cardLines(claim, width)            what the claim means, in at most five lines: the claim as said, Precisely,
//                                      Based on (with a sparkline when its source is one), Judgment, Not stated
//   compose(o)                         the grid of cells: dots in their cluster's color (heavier at ×N ≥ 2, ○ for a
//                                      revised claim, a faint ? beside a claim whose denominator or window was not
//                                      stated), the clusters' names dim at their centres, and, only around the hovered
//                                      claim, its links as thin glyph lines and its card; every other claim fades.
//                                      Rows of runs {s, style, node?}.
import { sparkChars } from './message.js'

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
  return { pos, names, w: W, h: H }
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
 * What a claim means, as the card under the pointer shows it: at most five lines, each [{s, style}]. The claim as said
 * (bold); Precisely; Based on (a cite; a sparkline when a source holds its values); Judgment and Not stated
 * only when the fork gave them. The claim and Precisely wrap to two lines while the card has room.
 */
export function cardLines(c, width, { cite = null, amber = null } = {}) {
  const W = Math.max(30, width)
  const body = W - LABEL
  const based = c.based_on || sourcesWords(c)
  const values = (c.sources || []).find(x => Array.isArray(x.values) && x.values.length > 1)?.values
  const spark = values ? sparkChars(values, 16) : ''
  const parts = [
    { key: 'claim', lines: wrap(c.text, W), style: { bold: true } },
    c.precisely ? { key: 'precisely', label: 'Precisely', lines: wrap(c.precisely, body), style: {} } : null,
    based || spark ? { key: 'based', label: 'Based on', lines: [cut(String(based || ''), body - (spark ? spark.length + 1 : 0))], style: cite ? { color: cite } : {}, spark } : null,
    c.judgment ? { key: 'judgment', label: 'Judgment', lines: wrap(c.judgment, body), style: {} } : null,
    c.unstated ? { key: 'unstated', label: 'Not stated', lines: wrap(c.unstated, body), style: {}, labelStyle: amber ? { color: amber } : { dim: true } } : null,
  ].filter(Boolean)
  // one line each for the parts that come after Precisely; the claim and Precisely take two while there is room
  for (const p of parts) if (!['claim', 'precisely'].includes(p.key) && p.lines.length > 1) p.lines = [cut(p.lines.join(' '), body)]
  const total = () => parts.reduce((n, p) => n + Math.min(2, p.lines.length), 0)
  for (const key of ['claim', 'precisely']) {
    const p = parts.find(x => x.key === key)
    if (p && p.lines.length > 2) p.lines = [p.lines[0], cut(p.lines.slice(1).join(' '), p.label ? body : W)]
  }
  for (const key of ['claim', 'precisely']) {
    const p = parts.find(x => x.key === key)
    if (p && total() > 5 && p.lines.length > 1) p.lines = [cut(p.lines.join(' '), p.label ? body : W)]
  }
  const out = []
  for (const p of parts) {
    p.lines.forEach((t, i) => {
      const runs = []
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
 * all), newest (ids the replay just added, drawn bold), focus (the claim hovered), colorOf (claim → color), amber (the
 * revision color), cite (the Based on color)}.
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
  // the hovered claim's links, as thin lines; a revision dashed, in a faint amber
  if (ringOn && near.size) {
    const a = o.lay.pos.get(o.focus)
    for (const [id, kind] of near) {
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
  // the claims; a claim whose denominator or window was not stated has a faint ? beside it
  const newest = o.newest || new Set()
  for (const c of shown) {
    const p = o.lay.pos.get(c.id)
    if (!p) continue
    const revised = !!c.revised_by && (!o.visible || o.visible.has(c.revised_by))
    const style = { color: o.colorOf(c), bold: c.n >= 2 || newest.has(c.id), faint: !lit(c.id) }
    // a claim said twice or more is drawn heavier
    set(p.x, p.y, revised ? '○' : c.n >= 2 ? '◉' : '●', style, { node: c.id })
    if (c.unstated && (cells[p.y]?.[p.x + 1]?.ch === ' ' || cells[p.y]?.[p.x + 1]?.edge)) set(p.x + 1, p.y, '?', { color: o.colorOf(c), faint: true }, { mark: true })
  }
  // the hovered claim's card, where it covers the fewest of its links
  let card = null
  if (ringOn) {
    const lines = cardLines(byId.get(o.focus), Math.min(W - 4, 104), { cite: o.cite, amber: o.amber })
    const h = lines.length
    const bw = Math.max(...lines.map(l => l.reduce((n, r) => n + r.s.length, 0)))
    const p = o.lay.pos.get(o.focus)
    const clampX = x => Math.max(1, Math.min(W - bw - 1, x))
    // beside it on the right, else under or over it starting near it, else on its left (where the lines' ends stand
    // away from the dot): each try costs what it covers, its links most
    const tries = [
      [p.x + 2, p.y, 0, true], [p.x + 2, p.y - h + 1, 0.1, true], [p.x - 2, p.y + 1, 0.2], [p.x - 2, p.y - h, 0.4],
      [p.x - bw + 3, p.y + 1, 0.6], [p.x - bw + 3, p.y - h, 0.8], [p.x - 1 - bw, p.y, 2.5, true], [p.x - 1 - bw, p.y - h + 1, 2.6, true],
    ]
    let best = null
    for (const [x0, y0, pen, beside] of tries) {
      const x = clampX(x0)
      if (y0 < 0 || y0 + h > H) continue
      if (p.x >= x - 1 && p.x <= x + bw && p.y >= y0 && p.y < y0 + h) continue
      if (beside && x !== x0) continue
      let cost = pen
      for (let y = y0; y < y0 + h; y++) {
        for (let xx = x - 1; xx <= x + bw; xx++) {
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
      for (let y = best.y; y < best.y + h; y++) for (let xx = best.x - 1; xx <= best.x + bw; xx++) set(xx, y, ' ', null, { card: true })
      lines.forEach((runs, i) => {
        let x = best.x
        for (const r of runs) for (const ch of r.s) set(x++, best.y + i, ch, r.style, { card: true })
      })
      card = { x: best.x, y: best.y, w: bw, h }
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
