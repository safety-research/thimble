// claimgraph.js: the Claims graph in terminal cells, as pure functions. No `$`, no DOM: the shell draws what it
// returns (claimsview.ts), and the tests read it.
//
//   layout(claims, clusters, {w, h})   a force layout (repulsion, a pull to each cluster's anchor) computed in cells
//                                      of about 1:2, then snapped to cells so no two claims touch: {pos, names}
//   neighbours(view, id)               the claims a claim links to: the claim it revised or that revised it, the
//                                      claims said just before and after it in the same message, those that share a
//                                      source; each with its kind ('revised' or 'link')
//   compose(o)                         the grid of cells: dots in their cluster's color (heavier at ×N ≥ 2, ○ for a
//                                      revised claim), the clusters' names dim at their centres, and, only around the
//                                      focused claim, its links as thin glyph lines and its full text; every other
//                                      claim fades. Rows of runs {s, style, node?}.

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

/**
 * The grid: rows of runs {s, style, node?}. o = {w, h, claims (the view's flat list, each with cluster, n, revised_by,
 * text), clusters (with their color), lay (layout's result), visible (ids shown, the time cursor's), focus, selected,
 * matches (ids a search lights; null with no search), query, colorOf (claim → color), amber (the revision color)}.
 */
export function compose(o) {
  const W = o.lay.w, H = o.lay.h
  const cells = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ', style: null })))
  const set = (x, y, ch, style, extra = {}) => { if (y >= 0 && y < H && x >= 0 && x < W) cells[y][x] = { ch, style, ...extra } }
  const shown = o.claims.filter(c => !o.visible || o.visible.has(c.id))
  const byId = new Map(o.claims.map(c => [c.id, c]))
  const near = o.focus && (!o.visible || o.visible.has(o.focus)) ? neighbours(o.claims, o.focus) : new Map()
  const lit = id => (o.matches ? o.matches.has(id) : !o.focus || id === o.focus || near.has(id))
  // the clusters' names, dim, where their claims are
  for (const n of o.lay.names) {
    if (!shown.some(c => c.cluster === n.id)) continue
    const fade = o.focus && byId.get(o.focus)?.cluster !== n.id
    for (let i = 0; i < n.name.length; i++) set(n.x + i, n.y, n.name[i], { dim: true, faint: !!fade || !!o.matches }, { name: true })
  }
  // the focused claim's links, as thin lines; a revision dashed, in amber
  if (o.focus && near.size) {
    const a = o.lay.pos.get(o.focus)
    for (const [id, kind] of near) {
      if (o.visible && !o.visible.has(id)) continue
      const b = o.lay.pos.get(id)
      if (!a || !b) continue
      line(a, b).forEach((p, i) => {
        const cur = cells[p.y]?.[p.x]
        if (!cur || cur.name || cur.label || cur.node || (cur.ch !== ' ' && !cur.edge)) return
        if (Math.abs(p.x - a.x) <= 1 && p.y === a.y) return
        if (kind === 'revised') { if (i % 2) return; set(p.x, p.y, p.ch === '─' ? '╌' : p.ch === '│' ? '╎' : p.ch, { color: o.amber }, { edge: true }) }
        else set(p.x, p.y, p.ch, { dim: true }, { edge: true })
      })
    }
  }
  // the claims
  for (const c of shown) {
    const p = o.lay.pos.get(c.id)
    if (!p) continue
    const revised = !!c.revised_by && (!o.visible || o.visible.has(c.revised_by))
    const style = { color: o.colorOf(c), bold: c.n >= 2, faint: !lit(c.id) }
    // a claim said twice or more is drawn heavier
    set(p.x, p.y, revised ? '○' : c.n >= 2 ? '⬤' : '●', style, { node: c.id })
  }
  // labels: the focused claim's whole text; a search's matches, the words found marked
  const labels = []
  const place = (id, text, style, mark = null) => {
    const p = o.lay.pos.get(id)
    if (!p) return
    const room = W - 2
    const t = text.length > room ? text.slice(0, room - 1) + '…' : text
    const tries = [[p.x + 2, p.y], [p.x - 2 - t.length, p.y], [p.x - Math.floor(t.length / 2), p.y + 1], [p.x - Math.floor(t.length / 2), p.y - 1], [p.x - Math.floor(t.length / 2), p.y + 2], [p.x - Math.floor(t.length / 2), p.y - 2]]
    for (const [x0, y] of tries) {
      const x = Math.max(0, Math.min(W - t.length, x0))
      if (y < 0 || y >= H) continue
      let ok = true
      for (let i = -1; i <= t.length && ok; i++) { const cell = cells[y][x + i]; if (cell && (cell.node || cell.label || cell.name)) ok = false }
      if (!ok) continue
      for (let i = 0; i < t.length; i++) {
        const inMark = mark && i >= mark[0] && i < mark[1]
        set(x + i, y, t[i], inMark ? { ...style, mark: true } : style, { label: true })
      }
      labels.push({ id, x, y, text: t })
      return
    }
  }
  if (o.focus && (!o.visible || o.visible.has(o.focus))) {
    const c = byId.get(o.focus)
    place(o.focus, c.text, { bold: true, strike: !!c.revised_by && (!o.visible || o.visible.has(c.revised_by)), sel: o.focus === o.selected })
  }
  if (o.matches) {
    const q = String(o.query || '').toLowerCase()
    for (const id of o.matches) {
      if (id === o.focus) continue
      const c = byId.get(id)
      if (!c || (o.visible && !o.visible.has(id))) continue
      const t = c.text.length > 60 ? c.text.slice(0, 59) + '…' : c.text
      const k = q ? t.toLowerCase().indexOf(q) : -1
      place(id, t, {}, k >= 0 ? [k, k + q.length] : null)
    }
  }
  // rows of runs: a claim's cell a run of its own (a press), the rest merged by style
  return cells.map(row => {
    const runs = []
    for (const cell of row) {
      const key = JSON.stringify(cell.style)
      const last = runs[runs.length - 1]
      if (!cell.node && last && !last.node && last.key === key) last.s += cell.ch
      else runs.push({ s: cell.ch, style: cell.style, key, ...(cell.node ? { node: cell.node } : {}) })
    }
    return runs.map(({ key, ...r }) => r)
  })
}
