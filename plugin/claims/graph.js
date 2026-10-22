// graph.js: the Claims pane as pure functions over the conversation's claims (store.js): the graph laid out in cells,
// the claim selected in a framed box over it, and where a claim was said. No `$`, no DOM: pane.tsx draws what this
// returns with Claude Code's own elements, and the tests read it as text.
//
//   the head        how many claims the conversation holds, and one action while the folder has no map yet: a press
//                   that asks Claude to add the claims of the whole folder (never a key, since it starts a turn)
//   the graph       the whole pane wide: each cluster a loose group of dots in its own color, its name in plain gray
//                   among them, the clusters spread over the pane, linked claims near each other; a hollow dot is a
//                   claim a later one corrected, a heavier one a claim said twice or more. A line means one thing: the
//                   two claims are related in meaning or cite the same place. At rest the lines inside a cluster are
//                   faint, drawn only where they cross no dot. A correction is no line: the corrected claim is hollow,
//                   and its history says what corrected it. The dots keep their places while the person walks them
//   the claim       once a claim is selected (a key or a press): every other dot and name dims, the claim's lines are
//                   drawn, and a framed box opens over the graph near its dot: its full sentence in bold (a press opens
//                   the message that said it, its words marked), and under it what an action opened: e its evidence
//                   (each citation near its words, with its check and the cited line), h its history
//   where it was said   the message that said the claim, its words marked, and the other places it was said
//
// A canvas (canvas()) is a grid of cells: text, dots that are parts (a press selects the claim), a framed box, and
// lines routed as ─ │ ╭ ╮ ╰ ╯ through blank cells (0.10's draw/term.js linkCells), each joining its two ends or not
// drawn. canvas.rows() gives each row as runs of {s, tone, bold, part}.
import { blocks } from '../marks/message.js'
import { edgesOf, findQuote, plainOf, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const len = s => Array.from(String(s ?? '')).length
/** A claim's words as a sentence: with its full stop. */
export const sentenceOf = s => one(s).replace(/([\p{L}\p{N}%)"'”’])$/u, '$1.')
const MAX_EVIDENCE = 4
const MAX_SENTENCE = 4

/** Words wrapped to lines of at most n characters; a word longer than n goes on over the next lines, so no letter is
 *  lost. */
export function wrap(text, n) {
  const out = []
  let cur = ''
  for (const w of one(text).split(' ')) {
    if (!w) continue
    let word = Array.from(w)
    if (cur && Array.from(cur).length + 1 + word.length <= n) { cur += ' ' + word.join(''); continue }
    if (cur) out.push(cur)
    while (word.length > n) { out.push(word.slice(0, n).join('')); word = word.slice(n) }
    cur = word.join('')
  }
  if (cur) out.push(cur)
  return out
}

/** A cluster's color: the six categorical tones in turn. */
export const toneOf = i => `c${(Math.max(0, i) % 6) + 1}`
/** A claim's dot: hollow once corrected, heavier when said twice or more. */
export const dotOf = c => (c.revised_by ? '○' : (c.n || 1) >= 2 ? '◉' : '●')

/** Who said a claim and when, in a few words, for a side thread: `turn 2`, `turn 2 · you`, `the folder`. */
export function whenOf(c) {
  if (c.by === 'folder') return 'the folder'
  return [c.turn != null ? `turn ${c.turn}` : '', c.by === 'person' ? 'you' : ''].filter(Boolean).join(' · ')
}

/** Who said a claim and how often, as the pane says it after the sentence: `you said this`, `said 3 times`. */
export function saidWords(c) {
  const n = c.n || 1
  if (c.by === 'person') return n >= 2 ? `you said this ${n} times` : 'you said this'
  if (c.by === 'folder') return "from the folder's map"
  return n >= 2 ? `said ${n} times` : ''
}

const hash = s => {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

// ------------------------------------------------------------------------------------------------ the canvas

// the box-drawing glyph of a cell by the sides its line leaves through: up 1, right 2, down 4, left 8
const SIDE_GLYPH = { 10: '─', 5: '│', 6: '╭', 12: '╮', 3: '╰', 9: '╯', 7: '├', 13: '┤', 14: '┬', 11: '┴', 15: '┼' }
const sideTo = (a, b) => (b.x > a.x ? 2 : b.x < a.x ? 8 : b.y > a.y ? 4 : 1)

/**
 * The cells of a link from (x0, y0) to (x1, y1), its ends left out, each {x, y, ch, sides}. It is straight when the ends
 * share a row or a column; else it goes across, then up or down at one column, then across again (`turn` 'v': down,
 * across at one row, down), so each glyph joins the next. `at` is the column (or row) of the middle leg.
 */
export function linkCells(x0, y0, x1, y1, turn, at) {
  const across = turn !== 'v'
  const mid = at != null ? at : across ? Math.round((x0 + x1) / 2) : Math.round((y0 + y1) / 2)
  const way = across ? [[mid, y0], [mid, y1], [x1, y1]] : [[x0, mid], [x1, mid], [x1, y1]]
  const P = [{ x: x0, y: y0 }]
  let guard = 8000
  for (const [tx, ty] of way) {
    let { x, y } = P[P.length - 1]
    while ((x !== tx || y !== ty) && guard--) {
      if (x !== tx) x += Math.sign(tx - x)
      else y += Math.sign(ty - y)
      P.push({ x, y })
    }
  }
  const out = []
  for (let i = 1; i < P.length - 1; i++) {
    const sides = sideTo(P[i], P[i - 1]) | sideTo(P[i], P[i + 1])
    out.push({ x: P[i].x, y: P[i].y, ch: SIDE_GLYPH[sides] || '─', sides })
  }
  return out
}

/** A grid of w × h cells to draw on. Runs are [{s, tone?, bold?}]. */
export function canvas(w, h) {
  const blank = () => ({ ch: ' ', tone: null, bold: false, part: null, fill: false })
  const cells = Array.from({ length: h }, () => Array.from({ length: w }, blank))
  const lines = new Map()
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h
  const c = {
    w, h, cells,
    put(x, y, ch, tone = null, o = {}) {
      if (!inside(x, y)) return
      cells[y][x] = { ch, tone, bold: !!o.bold, part: o.part ?? null, fill: !!o.fill }
    },
    /** Runs from (x, y), cut to `max` cells. */
    text(x, y, runs, max = Infinity) {
      let at = 0
      for (const r of runs) {
        for (const ch of Array.from(String(r.s ?? ''))) {
          if (at >= max) return
          c.put(x + at, y, ch, r.tone ?? null, { bold: r.bold, part: r.part, fill: true })
          at++
        }
      }
    },
    /** A dot that is a part: a press on it is a press on the part. */
    dot(x, y, glyph, tone, o = {}) { c.put(x, y, glyph, tone, { bold: o.bold, part: o.part }) },
    /** A framed box, its inside blanked, so no line runs through it. */
    box(x, y, bw, bh, tone) {
      if (bw < 2 || bh < 2) return
      for (let j = 1; j < bh - 1; j++) for (let i = 1; i < bw - 1; i++) c.put(x + i, y + j, ' ', null, { fill: true })
      c.put(x, y, '╭', tone, { fill: true }); c.put(x + bw - 1, y, '╮', tone, { fill: true })
      c.put(x, y + bh - 1, '╰', tone, { fill: true }); c.put(x + bw - 1, y + bh - 1, '╯', tone, { fill: true })
      for (let i = 1; i < bw - 1; i++) { c.put(x + i, y, '─', tone, { fill: true }); c.put(x + i, y + bh - 1, '─', tone, { fill: true }) }
      for (let j = 1; j < bh - 1; j++) { c.put(x, y + j, '│', tone, { fill: true }); c.put(x + bw - 1, y + j, '│', tone, { fill: true }) }
    },
    /** A line that joins its two ends or is not drawn: the first route whose cells are all blank, or lines of this
     *  canvas (which then meet as ┬ ┤ ┼); across first for a wide link, down first for a tall one, then the other, then
     *  with its middle leg beside either end. */
    link(x0, y0, x1, y1, tone) {
      const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0)
      const free = p => inside(p.x, p.y) && (lines.has(`${p.x},${p.y}`) || (cells[p.y][p.x].ch === ' ' && !cells[p.y][p.x].fill))
      const first = Math.abs(x1 - x0) >= Math.abs(y1 - y0) ? 'h' : 'v'
      const other = first === 'h' ? 'v' : 'h'
      const tries = [[first], [other], ['h', x0 + sx], ['h', x1 - sx], ['v', y0 + sy], ['v', y1 - sy]]
      const route = tries.map(([t, at]) => linkCells(x0, y0, x1, y1, t, at)).find(cs => cs.every(free))
      if (!route) return false
      for (const p of route) {
        const key = `${p.x},${p.y}`
        const had = lines.get(key)
        const sides = (had ? had.sides : 0) | p.sides
        const t = had ? had.tone : tone
        lines.set(key, { sides, tone: t })
        c.put(p.x, p.y, SIDE_GLYPH[sides] || '─', t)
      }
      return true
    },
    /** Each row as runs of the same look and part: [{s, tone, bold, part}]. Trailing blanks go. */
    rows() {
      return cells.map(row => {
        let end = row.length
        while (end > 0 && row[end - 1].ch === ' ' && !row[end - 1].part) end--
        const out = []
        for (const cell of row.slice(0, end)) {
          const last = out[out.length - 1]
          if (last && last.tone === cell.tone && last.bold === cell.bold && last.part === cell.part) last.s += cell.ch
          else out.push({ s: cell.ch, tone: cell.tone, bold: cell.bold, part: cell.part })
        }
        return out
      })
    },
  }
  return c
}

/** A canvas row as plain text (tests). */
export const rowText = runs => runs.map(r => r.s).join('')

// ------------------------------------------------------------------------------------------------ the layout

/**
 * Each cluster's cell of the area, w × h: the clusters in rows, as many to a row as keeps a cell a little wider than
 * tall to the eye (a cell is about twice as tall as wide), and a row with fewer clusters spreads them over its width.
 * [{g, x, y, w, h}]
 */
export function cellsOf(groups, W, H) {
  const n = groups.length
  let best = null
  for (let r = 1; r <= Math.max(1, n); r++) {
    const c = Math.ceil(n / r)
    if (r > 1 && Math.ceil(n / (r - 1)) === c) continue
    const cost = Math.abs(Math.log(W / c / ((2 * H) / r) / 1.6))
    if (!best || cost < best.cost) best = { r, c, cost }
  }
  const out = []
  if (!best) return out
  const ch = H / best.r
  groups.forEach((g, i) => {
    const row = Math.floor(i / best.c)
    const inRow = Math.min(best.c, n - row * best.c)
    const cw = W / inRow
    const col = i - row * best.c
    out.push({ g, x: Math.round(cw * col), y: Math.round(ch * row), w: Math.round(cw * (col + 1)) - Math.round(cw * col), h: Math.round(ch * (row + 1)) - Math.round(ch * row) })
  })
  return out
}

/** A cluster's claims in the order they go round it: each claim then the claims linked to it, so linked claims stand
 *  next to each other; earlier claims first. */
function ringOrder(nodes, edges) {
  const ids = new Set(nodes.map(n => n.id))
  const nb = new Map(nodes.map(n => [n.id, []]))
  for (const e of edges || []) if (ids.has(e.a) && ids.has(e.b) && e.kind !== 'corrects') { nb.get(e.a).push(e.b); nb.get(e.b).push(e.a) }
  const at = new Map(nodes.map((n, i) => [n.id, i]))
  const seen = new Set()
  const out = []
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    const queue = [n.id]
    seen.add(n.id)
    while (queue.length) {
      const id = queue.shift()
      out.push(nodes[at.get(id)])
      for (const m of nb.get(id).slice().sort((p, q) => at.get(p) - at.get(q))) if (!seen.has(m)) { seen.add(m); queue.push(m) }
    }
  }
  return out
}

/**
 * The graph laid out in cells, w × h, the whole area used: each cluster a cell of it (cellsOf), its name in the middle
 * of the cell, a little off center by its hash, and its claims a loose ring round the name, linked claims next to each
 * other. Each claim is snapped to a cell so no two dots crowd and no dot touches a name: first inside its cluster's
 * cell, else anywhere. Deterministic. {pos: Map(id -> {x, y}), names: [{id, name, x, y}], h}
 */
export function spread(nodes, clusters, edges, { w, h }) {
  const W = Math.max(20, w)
  const H = Math.max(3, h)
  const known = new Set(clusters.map(c => String(c.id)))
  const groups = clusters.map(c => ({ id: String(c.id), name: String(c.name), nodes: nodes.filter(n => String(n.cluster) === String(c.id)) })).filter(g => g.nodes.length)
  const loose = nodes.filter(n => !known.has(String(n.cluster)))
  if (loose.length) groups.push({ id: '', name: 'between clusters', nodes: loose })
  const cells = cellsOf(groups, W, H)
  // the names first, so no dot lands on one
  const names = cells.map(sl => {
    const name = cut(sl.g.name, Math.max(4, sl.w - 4))
    const l = len(name)
    const cx = sl.x + sl.w / 2 + (hash(sl.g.id + 'x') - 0.5) * sl.w * 0.2
    const cy = sl.y + sl.h / 2 + (hash(sl.g.id + 'y') - 0.5) * sl.h * 0.2
    const x = Math.max(sl.x + 1, Math.min(sl.x + sl.w - l - 1, Math.round(cx - l / 2)))
    const y = Math.max(0, Math.min(H - 1, Math.round(cy - 0.5)))
    return { id: sl.g.id, name, x, y, len: l, cx, cy: y }
  })
  const taken = []
  const onName = (x, y) => names.some(nm => nm.y === y && x >= nm.x - 2 && x <= nm.x + nm.len + 1)
  const free = (x, y, b, gap) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && !onName(x, y) && !taken.some(t => (t.y === y && Math.abs(t.x - x) < gap) || (Math.abs(t.y - y) === 1 && Math.abs(t.x - x) < 2))
  const near = (x0, y0, b, gap) => {
    for (let r = 0; r <= Math.max(W, H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -2 * r; dx <= 2 * r; dx++) {
          if (Math.abs(dy) !== r && Math.abs(dx) < 2 * r - 1) continue
          if (free(x0 + dx, y0 + dy, b, gap)) return { x: x0 + dx, y: y0 + dy }
        }
      }
    }
    return null
  }
  const all = { x0: 0, x1: W - 2, y0: 0, y1: H - 1 }
  const pos = new Map()
  cells.forEach((sl, ci) => {
    const nm = names[ci]
    const order = ringOrder(sl.g.nodes, edges)
    const k = order.length
    const rx = Math.max(2, sl.w / 2 - 4)
    const ry = Math.max(1, sl.h / 2 - 1)
    const box = { x0: sl.x + 1, x1: Math.max(sl.x + 1, sl.x + sl.w - 3), y0: sl.y, y1: Math.max(sl.y, sl.y + sl.h - 1) }
    const turn = hash(sl.g.id) * Math.PI * 2
    order.forEach((nd, i) => {
      // a few claims go round one ring, linked ones side by side; many fill the area round the name, a spiral out
      const a = k <= 10 ? turn + (Math.PI * 2 * i) / k : turn + i * 2.39996
      const f = k <= 2 ? 0.7 : k <= 10 ? 0.45 + 0.55 * hash(nd.id + '#') : 0.3 + 0.7 * Math.sqrt((i + 0.5) / k)
      const x0 = Math.round(nm.cx + Math.cos(a) * rx * f)
      const y0 = Math.round(nm.cy + Math.sin(a) * ry * f)
      const got = near(x0, y0, box, 5) || near(x0, y0, box, 3) || near(x0, y0, all, 3) || { x: Math.max(0, Math.min(W - 2, x0)), y: Math.max(0, Math.min(H - 1, y0)) }
      taken.push(got)
      pos.set(nd.id, got)
    })
  })
  return { pos, names: names.map(({ id, name, x, y }) => ({ id, name, x, y })), h: H }
}

/** Where the box of the claim selected stands over the graph, w × h, so it covers neither the claim's dot nor, where it
 *  can, the claims linked to it: beside the dot, above or under it. {x, y} */
export function boxAt(p, bw, bh, W, H, nearPos) {
  const xs = [p.x - bw - 3, p.x + 4, Math.round(p.x - bw / 2)]
  const ys = [p.y - bh - 1, p.y + 2, p.y - Math.floor(bh / 2)]
  let best = null
  for (const x0 of xs) {
    for (const y0 of ys) {
      const x = Math.max(0, Math.min(W - bw, x0))
      const y = Math.max(0, Math.min(H - bh, y0))
      const covers = q => q.x >= x - 1 && q.x <= x + bw && q.y >= y && q.y < y + bh
      const cost = (covers(p) ? 1000 : 0) + nearPos.filter(covers).length * 10 + Math.abs(x - x0) + Math.abs(y - y0) * 2 + Math.hypot(x + bw / 2 - p.x, (y + bh / 2 - p.y) * 2) / 20
      if (!best || cost < best.cost) best = { x, y, cost }
    }
  }
  return { x: best.x, y: best.y }
}

/**
 * The lines a graph draws, in the order drawn (lines that share a cell join there). A line joins two claims related in
 * meaning or citing the same place; a correction is no line, since the corrected claim shows it (a hollow dot, its
 * history). Every line of the claim selected, bright; then, faint, each line between two claims of one cluster where
 * it crosses no dot. A line to a claim of another cluster is drawn only for the claim selected. [{e, bright}]
 */
export function linesOf(edges, pos, claims, selected) {
  const cl = new Map(claims.map(c => [c.id, String(c.cluster)]))
  const dots = new Set([...pos.values()].map(p => `${p.x},${p.y}`))
  const clear = e => {
    const a = pos.get(e.a), b = pos.get(e.b)
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    for (let i = 1; i < n; i++) if (dots.has(`${Math.round(a.x + ((b.x - a.x) * i) / n)},${Math.round(a.y + ((b.y - a.y) * i) / n)}`)) return false
    return true
  }
  const here = (edges || []).filter(e => e.kind !== 'corrects' && pos.has(e.a) && pos.has(e.b))
  const mine = e => e.a === selected || e.b === selected
  return [
    ...here.filter(mine).map(e => ({ e, bright: true })),
    ...here.filter(e => !mine(e) && cl.get(e.a) === cl.get(e.b) && clear(e)).map(e => ({ e, bright: false })),
  ]
}

/** A claim's history: the claims before it that it corrected, itself, and the claims after it that corrected it, oldest
 *  first. A claim never corrected and correcting none has a history of one. */
export function historyOf(claim, byId) {
  const out = [claim]
  const seen = new Set([claim.id])
  for (let c = claim; c.revises && byId.has(c.revises) && !seen.has(c.revises);) { c = byId.get(c.revises); seen.add(c.id); out.unshift(c) }
  for (let c = claim; c.revised_by && byId.has(c.revised_by) && !seen.has(c.revised_by);) { c = byId.get(c.revised_by); seen.add(c.id); out.push(c) }
  return out
}

// ------------------------------------------------------------------------------------------------ the data

const slim = c => ({
  id: c.id, text: c.text, by: c.by, cluster: c.cluster ?? null, turn: c.turn ?? null, n: c.n || 1,
  ...(c.revised_by ? { revised_by: c.revised_by } : {}), ...(c.revises ? { revises: c.revises } : {}),
  ...(c.folder ? { folder: true } : {}), ...(c.links && c.links.length ? { links: c.links.map(l => ({ to: l.to, how: l.how })) } : {}),
  sources: (c.sources || []).slice(0, 8),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row ?? null, by: s.by, turn: s.turn ?? null, quote: s.quote || '', sentence: s.sentence || '', ...(s.start != null ? { start: s.start, end: s.end } : {}), ...(s.ref ? { ref: s.ref } : {}) })),
})

/** The store as the pane reads it: its claims in the order listed (cluster by cluster), the groups with their colors'
 *  order, the edges, and the head's facts. */
export function paneData(store) {
  const view = viewOf({ clusters: [], gaps: [], ...(store || {}), claims: Array.isArray(store?.claims) ? store.claims : [] })
  const claims = view.flat.map(slim)
  const groups = view.groups.map((g, i) => ({ id: g.id ?? null, name: g.name, folder: g.from === 'folder', i }))
  return {
    total: view.total, clusters: view.clusters, last: view.last, gaps: (view.gaps || []).slice(-3),
    claims, groups, edges: edgesOf(view.flat),
    offer: store?.offer || null, folder: store?.folder || null, asked: store?.folderAsked || null,
  }
}

const num = c => Number(/\d+$/.exec(String(c.id))?.[0] || 0)

/** The claim the pane shows: the one the state names, else the newest correction of the last turn, else the newest
 *  claim. After a turn that came since the selection, the pane opens on what is new. {claim, fresh} */
export function selectedOf(data, st = {}) {
  const claims = data.claims || []
  if (!claims.length) return { claim: null, fresh: false }
  const byId = new Map(claims.map(c => [c.id, c]))
  const newest = claims.reduce((b, c) => ((c.turn ?? -1) > (b.turn ?? -1) || ((c.turn ?? -1) === (b.turn ?? -1) && num(c) > num(b)) ? c : b))
  const fixes = claims.filter(c => c.revises && c.turn != null && c.turn === newest.turn)
  const fresh = st.at != null && data.last != null && st.at < data.last
  const claim = (!fresh && byId.get(st.claim)) || (fixes.length ? fixes.reduce((b, c) => (num(c) > num(b) ? c : b)) : newest)
  return { claim, fresh }
}

/** The claim after or before the one selected, in the order listed (j k). */
export function stepClaim(data, id, dir) {
  const claims = data.claims || []
  if (!claims.length) return null
  const i = Math.max(0, claims.findIndex(c => c.id === id))
  return claims[(i + dir + claims.length) % claims.length].id
}

/** The first claim of the cluster after or before the selected one's (n p). */
export function hopCluster(data, id, dir) {
  const claims = data.claims || []
  const claim = claims.find(c => c.id === id)
  if (!claim) return null
  const order = [...new Set(claims.map(c => String(c.cluster)))]
  const to = order[(order.indexOf(String(claim.cluster)) + dir + order.length) % order.length]
  return claims.find(c => String(c.cluster) === to)?.id ?? null
}

/** A claim's evidence: its sources, at most MAX_EVIDENCE. */
export const evidenceOf = c => (c.sources || []).slice(0, MAX_EVIDENCE)

/** What the side thread about the pane is about: the claim selected, or the place it was said. Text a model reads. */
export function threadAbout(c, source = false) {
  if (!c) return 'the claims of this session as a graph, in clusters'
  if (source) return `where the claim "${cut(c.text, 200)}" was said (${whenOf(c) || 'this session'})`
  const said = (c.said || []).find(x => x.sentence || x.quote)
  return `the claims of this session as a graph, in clusters; the claim selected is "${cut(c.text, 200)}" (${whenOf(c) || 'this session'}${said ? `, said as "${cut(said.sentence || said.quote, 240)}"` : ''})`
}

// ------------------------------------------------------------------------------------------------ the graph

// the layouts made lately, by what they were made of: the graph does not change while the person walks its dots, and a
// layout takes the most time of a drawing
const LAYOUTS = new Map()
const MAX_LAYOUTS = 24

function layOf(claims, groups, edges, W, h) {
  const order = claims.slice().sort((p, q) => (p.turn ?? 0) - (q.turn ?? 0) || num(p) - num(q))
  const named = groups.map(g => ({ id: g.id, name: g.name }))
  const nodes = order.map(c => ({ id: c.id, cluster: c.cluster }))
  const key = JSON.stringify([W, h, nodes, named, (edges || []).map(e => [e.a, e.b])])
  let got = LAYOUTS.get(key)
  if (!got) {
    got = spread(nodes, named, edges, { w: W, h })
    LAYOUTS.set(key, got)
    if (LAYOUTS.size > MAX_LAYOUTS) LAYOUTS.delete(LAYOUTS.keys().next().value)
  }
  return got
}

/** The words of a source in the claim's box, as runs: a citation's check, its words, the cited place and line; the
 *  folder's evidence as its quote and place. */
export function evidenceRuns(s) {
  if (s.quote && !s.row) return [{ s: `“${one(s.quote)}”`, tone: 'cite' }, { s: ` ${s.label || s.ref}`, tone: 'dim' }]
  // the check's words, as the evidence pane says them (marks/evidence.tsx)
  const status = s.status || 'unchecked'
  const unconfirmed = status === 'failed' && s.failedBy === 'evidence'
  const tone = status === 'verified' ? 'good' : status === 'corrected' || unconfirmed ? 'warn' : status === 'failed' ? 'bad' : 'dim'
  const word = unconfirmed ? 'not confirmed' : ({ failed: 'wrong', unchecked: 'not checked', gone: 'no longer in the session' })[status] || status
  const out = [{ s: word, tone, bold: true }, { s: ' ' }, { s: one(s.shown || s.label), tone: 'cite' }]
  if (s.place) out.push({ s: `  ${s.place}`, tone: 'dim' })
  if (s.line) out.push({ s: `  ${one(s.line)}` })
  return out
}

/** The history as rows in the claim's box: each version, oldest first, with where it was said; the one selected bold,
 *  each other a press that selects it. [{runs, part}] */
function historyRows(history, claim, tone) {
  const out = []
  for (const c of history) {
    const said = (c.said || []).find(x => x.sentence || x.quote)
    const who = c.by === 'person' ? 'you said' : c.by === 'folder' ? "the folder's map" : 'Claude said'
    const part = c.id === claim.id ? null : `was-${c.id}`
    out.push({ runs: [{ s: dotOf(c), tone: tone(c) }, { s: ' ' }, { s: sentenceOf(c.text), bold: c.id === claim.id }], part })
    out.push({ runs: said ? [{ s: '  ' }, { s: who, tone: 'dim' }, { s: ` “${one(said.sentence || said.quote)}”` }] : [{ s: '  ' }, { s: who, tone: 'dim' }], part })
  }
  return out
}

/** One graph of clusters on a canvas: their names in plain gray, their claims as dots in the cluster's color, the
 *  links between them; with a claim selected (`chosen`), everything else dimmed, the claim's lines drawn, and its box
 *  over the graph near its dot. */
function graphOf({ claims, groups, edges, W, h, claim, near, tone, chosen, box }) {
  const lay = layOf(claims, groups, edges, W, h)
  const c = canvas(W, lay.h)
  let frame = null
  if (box) {
    const inner = Math.max(20, Math.min(W - 6, 92))
    const who = saidWords(claim)
    const all = wrap(`${sentenceOf(claim.text)}${who ? ` · ${who}` : ''}`, inner - 2)
    const words = all.slice(0, MAX_SENTENCE)
    if (all.length > MAX_SENTENCE) words[MAX_SENTENCE - 1] = cut(words[MAX_SENTENCE - 1] + ' ' + all[MAX_SENTENCE], inner - 2)
    const said = words.map((l, i) => {
      // the words of who said it stay dim
      const at = who && i === words.length - 1 ? l.lastIndexOf(` · ${who}`) : -1
      const body = at >= 0 ? [{ s: l.slice(0, at), bold: true, part: 'said' }, { s: l.slice(at), tone: 'dim', part: 'said' }] : [{ s: l, bold: true, part: 'said' }]
      return { runs: [i ? { s: '  ', part: 'said' } : { s: `${dotOf(claim)} `, tone: tone(claim), part: 'said' }, ...body], part: 'said' }
    })
    const ev = box.evidence
    const more = box.open === 'ev' ? (ev.length ? ev.map((s, i) => ({ runs: evidenceRuns(s), part: s.row || s.n ? `ev-${i + 1}` : null })) : [{ runs: [{ s: 'It cites nothing.', tone: 'dim' }], part: null }])
      : box.open === 'hist' ? historyRows(box.history, claim, tone) : []
    const lines = [...said, ...more].slice(0, Math.max(1, lay.h - 2))
    const vis = l => l.runs.reduce((n, r) => n + len(r.s), 0)
    const bw = Math.min(W, Math.max(30, ...lines.map(l => Math.min(inner, vis(l)))) + 4)
    const bh = lines.length + 2
    const p = lay.pos.get(claim.id)
    const at = boxAt(p, bw, bh, W, lay.h, [...near].map(id => lay.pos.get(id)).filter(Boolean))
    frame = { x: at.x, y: at.y, w: bw, h: bh, lines }
  }
  const short = ed => { const a = lay.pos.get(ed.a), b = lay.pos.get(ed.b); return Math.abs(a.x - b.x) <= 10 && Math.abs(a.y - b.y) <= 2 }
  const under = q => frame && q.x >= frame.x && q.x < frame.x + frame.w && q.y >= frame.y && q.y < frame.y + frame.h
  for (const nm of lay.names) c.text(nm.x, nm.y, [{ s: nm.name, tone: chosen ? 'dim-faint' : 'dim' }])
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (!p || under(p)) continue
    const lit = !chosen || x.id === claim.id || near.has(x.id)
    c.dot(p.x, p.y, dotOf(x), lit ? tone(x) : `${tone(x)}-faint`, { bold: chosen && (x.id === claim.id || near.has(x.id)), part: `n:${x.id}` })
  }
  if (frame) {
    c.box(frame.x, frame.y, frame.w, frame.h, 'dim')
    frame.lines.forEach((l, i) => c.text(frame.x + 2, frame.y + 1 + i, l.runs.map(r => ({ ...r, part: r.part ?? l.part })), frame.w - 4))
  }
  // the lines last, so each goes around the dots, the names and the box, or is not drawn
  for (const { e: ed, bright } of linesOf(edges, lay.pos, claims, claim.id)) {
    if (chosen ? !bright : !short(ed)) continue
    const a = lay.pos.get(ed.a), b = lay.pos.get(ed.b)
    c.link(a.x, a.y, b.x, b.y, bright && chosen ? 'dim' : 'dim-faint')
  }
  return c
}

/**
 * The Claims pane as rows of runs, w × h cells (the rows the pane has; the keys' row under it takes two): the head,
 * then the graphs (the session's clusters, then the folder's map under its own line). `st` = {claim, open, at}: the
 * claim selected, what its box opened ('ev' | 'hist'), the last turn when it was selected. Returns {head, graph, claim,
 * history, chosen, open}; head and graph are rows of runs, a run's `part` what a press on it does (`n:<id>` a dot,
 * `said`, `ev-N`, `was-<id>`, `folder`).
 */
export function graphView(data, st = {}, { w = 90, h = 40 } = {}) {
  const W = Math.max(40, w)
  const claims = data.claims || []
  const byId = new Map(claims.map(c => [c.id, c]))
  const groups = data.groups || []
  const gi = new Map(groups.map(g => [String(g.id), g.i]))
  const tone = c => toneOf(gi.get(String(c.cluster)) ?? 0)
  const head = [headRuns(data)]
  for (const g of data.gaps || []) head.push([{ s: `Turn ${g.turn} was not read: `, tone: 'bad' }, { s: cut(g.why || 'the look at the answer failed', W - 24), tone: 'dim' }])
  if (!claims.length) {
    head.push([], [{ s: 'No claims yet. After each answer, the statements in it come here.', tone: 'dim' }])
    return { head, graph: [], claim: null, history: [], chosen: false, open: null }
  }
  const { claim, fresh } = selectedOf(data, st)
  const evidence = evidenceOf(claim)
  const history = historyOf(claim, byId)
  const open = st.open === 'ev' || (st.open === 'hist' && history.length > 1) ? st.open : null
  const H = Math.max(10, h - 2)
  const room = Math.max(6, H - head.length - 1)
  const chosen = (!fresh && byId.has(st.claim)) || !!open
  const edges = data.edges || []
  const near = new Set(edges.filter(e => e.kind !== 'corrects' && (e.a === claim.id || e.b === claim.id)).map(e => (e.a === claim.id ? e.b : e.a)))
  const mine = groups.filter(g => !g.folder)
  const theirs = groups.filter(g => g.folder)
  const inGroups = gs => { const ids = new Set(gs.map(g => String(g.id))); return claims.filter(c => ids.has(String(c.cluster)) || (gs === mine && !groups.some(g => String(g.id) === String(c.cluster)))) }
  const parts = [[mine, inGroups(mine)], [theirs, inGroups(theirs)]].filter(([gs, cs]) => gs.length && cs.length)
  const leads = parts.map(([gs], pi) => (pi ? 1 : 0) + (gs === theirs ? 1 : 0))
  const free = room - leads.reduce((a, b) => a + b, 0)
  const rows = parts.length > 1 ? parts.map(([, cs], pi) => (pi ? free - Math.max(4, Math.round((free * parts[0][1].length) / claims.length)) : Math.max(4, Math.round((free * cs.length) / claims.length)))) : [free]
  const graph = []
  parts.forEach(([gs, cs], pi) => {
    if (pi) graph.push([])
    if (gs === theirs) graph.push([{ s: `the whole folder's map · ${cs.length} claim${cs.length === 1 ? '' : 's'}`, tone: 'dim' }])
    const here = cs.some(c => c.id === claim.id)
    graph.push(...graphOf({ claims: cs, groups: gs, edges, W, h: rows[pi], claim, near, tone, chosen, box: chosen && here ? { open, evidence, history } : null }).rows())
  })
  return { head, graph, claim, history, chosen, open }
}

/** The head: Claims, how many and in how many clusters, then the folder's action (a press), or that Claude reads it. */
function headRuns(data) {
  const n = data.total || 0
  const groups = (data.groups || []).length
  const out = [{ s: 'Claims', tone: 'c2', bold: true }]
  if (n) out.push({ s: `   ${n.toLocaleString('en-US')}${groups > 1 ? ` · ${groups} clusters` : ''}`, tone: 'dim' })
  if (data.folder) return out
  if (data.asked) out.push({ s: '   ' }, { s: 'Claude is reading the whole folder for its claims…', tone: 'dim' })
  else if (data.offer) out.push({ s: '   ' }, { s: "add the whole folder's claims", tone: 'accent', part: 'folder' })
  return out
}

// ------------------------------------------------------------------------------------------------ where it was said

/** Where a place's words are in a message's markdown: [start, end), from the place's offsets when they still hold its
 *  words, else found again by its quote; null when they are not there. */
export function spanOf(md, place) {
  const s = String(md || '')
  const start = Number(place.start), end = Number(place.end)
  const fold = x => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (Number.isFinite(start) && Number.isFinite(end) && end > start && end <= s.length && fold(plainOf(s.slice(start, end)).plain) === fold(plainOf(place.quote).plain)) return [start, end]
  const hit = findQuote(s, place.quote || place.sentence || '')
  return hit ? [hit.start, hit.end] : null
}

/**
 * A message as a person reads it, in rows of at most n characters: each block's words (an item after a bullet), a
 * blank row where the message has one, and the place's words marked. A window of at most `max` rows that opens a few
 * rows above the marked words. {rows: [[{s, on}]], at, last}: at and last, the first and last rows marked.
 */
export function messageRows(md, place, n, max = 16) {
  const s = String(md || '')
  const span = spanOf(s, place)
  if (!span) return null
  const rows = []
  for (const b of blocks(s)) {
    if (b.type === 'rule') continue
    if (rows.length && b.gap) rows.push([{ s: ' ', on: false }])
    const lead = b.type === 'item' ? '• ' : b.type === 'quote' ? '│ ' : ''
    const p = plainOf(s.slice(b.from, b.to))
    const marked = p.at.map(m => m + b.from >= span[0] && m + b.from < span[1])
    markWrap(p.plain, marked, n - lead.length).forEach((l, i) => rows.push([{ s: i ? ' '.repeat(lead.length) : lead, on: false }, ...l]))
  }
  const on = rows.map(r => r.some(x => x.on))
  const at = on.indexOf(true)
  if (at < 0) return null
  const last = on.lastIndexOf(true)
  const from = Math.max(0, Math.min(at - 4, last + 3 - max))
  return { rows: rows.slice(from, from + max), at: at - from, last: Math.min(last, from + max - 1) - from }
}

/** Plain words wrapped to lines of at most n characters, each line runs {s, on}, a word on when any of its characters
 *  is marked. */
export function markWrap(plain, marked, n) {
  const lines = []
  let cur = []
  let l = 0
  const re = /\S+/g
  let m
  while ((m = re.exec(plain))) {
    const w = m[0].length > n ? m[0].slice(0, n - 1) + '…' : m[0]
    const on = marked.slice(m.index, m.index + m[0].length).some(Boolean)
    if (l && l + 1 + w.length > n) { lines.push(cur); cur = []; l = 0 }
    if (cur.length) cur.push({ s: ' ', on: on && cur[cur.length - 1].on })
    cur.push({ s: w, on })
    l += (l ? 1 : 0) + w.length
  }
  if (cur.length) lines.push(cur)
  return lines
}

/** Where a claim was said, as rows of runs: the message that said it, its words marked, and the other places it was
 *  said. `text` is the message's markdown (null when it is not in the session any more). */
export function sourceView(c, text, w = 90) {
  const W = Math.max(40, w)
  if (!c) return [[{ s: 'That claim is not in this session any more.', tone: 'dim' }]]
  const said = (c.said || []).filter(x => x.by !== 'folder')
  const first = said[0] || null
  const who = first ? (first.by === 'person' ? 'your message' : "Claude's message") : ''
  const lines = [[{ s: 'Where it was said', tone: 'c2', bold: true }, { s: `  ${who}`, tone: 'dim' }], []]
  const msg = first && text ? messageRows(text, first, W - 1) : null
  if (msg) msg.rows.forEach(r => lines.push(r.map(x => (x.on ? { s: x.s, tone: 'accent', bold: true } : { s: x.s }))))
  else if (first) lines.push([{ s: `“${cut(first.sentence || first.quote, W - 4)}”`, tone: 'accent', bold: true }])
  else {
    // a claim of the folder's map: said by its evidence, each a quote of a record of the folder
    lines[0] = [{ s: 'Where it was said', tone: 'c2', bold: true }, { s: "  the folder's map", tone: 'dim' }]
    for (const s of (c.sources || []).slice(0, MAX_EVIDENCE)) lines.push([{ s: s.quote ? `“${cut(s.quote, W - 24)}”` : '', tone: 'accent', bold: true }, { s: ` ${s.label || s.ref}`, tone: 'dim' }])
  }
  const again = said.slice(1)
  if (again.length) {
    lines.push([], [{ s: 'also said', tone: 'dim' }])
    for (const p of again) lines.push([...(p.by === 'person' ? [{ s: 'you ', tone: 'dim' }] : []), { s: `“${cut(p.sentence || p.quote, W - 8)}”` }])
  }
  return lines
}
