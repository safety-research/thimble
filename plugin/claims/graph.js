// graph.js: the Claims pane as pure functions over the conversation's claims (store.js): the map of clusters on top,
// the detail under it (the cluster chosen and its claims, or the claim picked), and where a claim was said. No `$`, no
// DOM: pane.tsx draws what this returns with Claude Code's own elements, and the tests read it as text.
//
//   the head        at rest: Claims and how many (`no claims yet` before the first); `+N new`
//                   bold for a moment after claims came in. Once a cluster or a claim is chosen it goes (the pane's
//                   top row says where back goes)
//   the overview    at rest and with a cluster chosen, on top: the map, every cluster a loose group of solid dots in
//                   its own color in a cell, its name under them (two lines at most, then …). Every dot is the same ●:
//                   a new claim (came in while the person browsed) is bold, the cluster's current claim inverse in its
//                   color. No lines join the dots, which keep their places while the person walks them. Three
//                   columns of cells (two in a pane under 64 columns), each four rows (two rows of dots, a name of
//                   two lines) or taller, in at most 40% of the pane's rows (MAP_SHARE). When the map would be too
//                   crowded to read (its cells do not fit in that share, or a cluster has more claims than its cell
//                   holds, cellSlots) or the pane is narrow, the overview is the clusters one row each instead: the
//                   name and a row of dots (clusters past half the pane's rows, smallest first, join a near one:
//                   fitClusters)
//   the selection   at rest nothing is chosen and nothing shows under the overview. A press on a name, or p n,
//                   chooses a cluster: its dots and name bold in its color, every other in the text color. A press on
//                   a dot, or on a claim of the cluster's list, picks that claim
//   the detail      a cluster chosen, under the overview after a rule: its name, bold, its orienting line, then its
//                   claims one line each, numbered (cut with …), the current one (`cur`, k j) whole, marked ▸ and bold in the
//                   cluster's color. A claim picked: the overview goes and the detail takes the pane: its cluster's
//                   name in its color (and its orienting line while all fits), the claim, bold; its description (the
//                   lens's `because`, else the reply's sentences that said it), plain; then `show evidence (N
//                   citations)`, and with e (`open`) its citations as the tray's citation card draws them, each in a
//                   frame (with three or more that do not fit, the current one, `cite`, k j, whole and the others one
//                   line each). h shows a corrected claim's History (one
//                   word-level diff per correction and its reason); c the current citation's code and output whole.
//                   A detail taller than its room scrolls (scrollWindow: the wheel and d u, pane.tsx), with `↑ N more
//                   lines` and `↓ N more lines` where rows are out of view (`N more claims` in a cluster's list); a
//                   claim's cluster stays on top
//   where it was said   the message that said the claim, its words marked, and the other places it was said
//
// A canvas (canvas()) is a grid of cells: text and dots that are parts (a press on the part; the blank cells beside a
// dot or a name are part of it). canvas.rows() gives each row as runs of {s, tone, bold, inverse, part}.
import { blocks, marksIn } from '../marks/message.js'
import { tableLines } from '../marks/table.mjs'
import { evidenceLine, firstSentence, hiddenOutput, lineWindow, moreLines, printLine } from '../tray/tray.mjs'
import { cutWords, edgesOf, findQuote, likeness, plainOf, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const len = s => Array.from(String(s ?? '')).length
/** A claim's words as a sentence: with its full stop. */
export const sentenceOf = s => one(s).replace(/([\p{L}\p{N}%)"'”’])$/u, '$1.')

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

/** A cluster's name wrapped to lines of at most n characters (wrap), a … that ends it on the line of the word before
 *  it. */
export const wrapName = (name, n) => wrap(one(name).replace(/ …$/, '\u2060…'), n).map(l => l.replace('\u2060…', ' …'))

/** A cluster's color: the six categorical tones in turn. */
export const toneOf = i => `c${(Math.max(0, i) % 6) + 1}`
/** A claim's dot on the map: one solid dot for every claim. */
export const DOT = '●'

/** Who said a claim and when, in a few words, for a side thread: `turn 2`, `turn 2 · you`. */
export function whenOf(c) {
  return [c.turn != null ? `turn ${c.turn}` : '', c.by === 'person' ? 'you' : ''].filter(Boolean).join(' · ')
}

const hash = s => {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

// ------------------------------------------------------------------------------------------------ the canvas

/** A grid of w × h cells to draw on. Runs are [{s, tone?, bold?}]. */
export function canvas(w, h) {
  const blank = () => ({ ch: ' ', tone: null, bold: false, inverse: false, part: null, fill: false })
  const cells = Array.from({ length: h }, () => Array.from({ length: w }, blank))
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h
  const c = {
    w, h, cells,
    put(x, y, ch, tone = null, o = {}) {
      if (!inside(x, y)) return
      cells[y][x] = { ch, tone, bold: !!o.bold, inverse: !!o.inverse, part: o.part ?? null, fill: !!o.fill }
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
    dot(x, y, glyph, tone, o = {}) { c.put(x, y, glyph, tone, { bold: o.bold, inverse: o.inverse, part: o.part }) },
    /** A blank cell made part of a press beside it. */
    pad(x, y, part) { if (inside(x, y) && cells[y][x].ch === ' ' && !cells[y][x].part && !cells[y][x].fill) cells[y][x].part = part },
    /** Each row as runs of the same look and part: [{s, tone, bold, inverse?, part}]. Trailing blanks go. */
    rows() {
      return cells.map(row => {
        let end = row.length
        while (end > 0 && row[end - 1].ch === ' ' && !row[end - 1].part) end--
        const out = []
        for (const cell of row.slice(0, end)) {
          const last = out[out.length - 1]
          if (last && last.tone === cell.tone && last.bold === cell.bold && !!last.inverse === cell.inverse && last.part === cell.part) last.s += cell.ch
          else out.push({ s: cell.ch, tone: cell.tone, bold: cell.bold, ...(cell.inverse ? { inverse: true } : {}), part: cell.part })
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
 * Each cluster's cell of the area, w × h: the clusters in rows, `cols` to a row, else as many to a row as keeps a cell a
 * little wider than tall to the eye (a cell is about twice as tall as wide), and a row with fewer clusters spreads them
 * over its width.
 * [{g, x, y, w, h}]
 */
export function cellsOf(groups, W, H, cols = 0) {
  const n = groups.length
  // `cols`: that many to a row (fewer when there are fewer clusters)
  const fixed = cols > 0 && n ? { r: Math.ceil(n / Math.min(cols, n)), c: Math.min(cols, n) } : null
  let best = fixed
  for (let r = 1; !fixed && r <= Math.max(1, n); r++) {
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
 * The graph laid out in cells, w × h, the whole area used: each cluster a cell of it (cellsOf), its name wrapped at the
 * foot of the cell, a little off center by its hash, and its claims a loose ring above the name, linked claims next to
 * each other. Each claim is snapped to a cell so no two dots crowd and no dot touches a name: first inside its
 * cluster's cell, else anywhere. Deterministic. {pos: Map(id -> {x, y}), names: [{id, name, lines, x, y}], h}
 */
export function spread(nodes, clusters, edges, { w, h, cols = 0 }) {
  const W = Math.max(20, w)
  const H = Math.max(3, h)
  const known = new Set(clusters.map(c => String(c.id)))
  const groups = clusters.map(c => ({ id: String(c.id), name: String(c.name), nodes: nodes.filter(n => String(n.cluster) === String(c.id)) })).filter(g => g.nodes.length)
  const loose = nodes.filter(n => !known.has(String(n.cluster)))
  if (loose.length) groups.push({ id: '', name: 'between clusters', nodes: loose })
  const cells = cellsOf(groups, W, H, cols)
  // the names first, at the foot of their cells, so no dot lands on one: each wrapped to its cell's width, so a long
  // name shows in full (a cell too short for all its lines ends the last one in …)
  const names = cells.map(sl => {
    const room = Math.max(4, sl.w - 2)
    // at most two lines (fewer in a short cell), the last ending after a whole word in … when the name goes on
    const most = Math.max(1, Math.min(2, sl.h - 1))
    let lines = wrapName(sl.g.name, room)
    if (lines.length > most) lines = [...lines.slice(0, most - 1), cutWords(`${lines.slice(most - 1).join(' ')} …`, room)]
    const l = Math.max(1, ...lines.map(len))
    const jx = (hash(sl.g.id + 'x') - 0.5) * Math.max(0, sl.w - l - 2) * 0.3
    const x = Math.max(sl.x + 1, Math.min(sl.x + sl.w - l - 1, Math.round(sl.x + (sl.w - l) / 2 + jx)))
    // a blank row under it, before the next row of clusters, where the cell has room
    const gap = sl.y + sl.h < H && sl.h >= lines.length + 3 ? 1 : 0
    const y = Math.max(0, Math.min(H - lines.length, sl.y + sl.h - lines.length - gap))
    return { id: sl.g.id, name: sl.g.name, lines, x, y, len: l, cell: { x: sl.x, y: sl.y } }
  })
  const taken = []
  const onName = (x, y) => names.some(nm => y >= nm.y && y < nm.y + nm.lines.length && x >= nm.x - 2 && x <= nm.x + nm.len + 1)
  // `loose`: dots in the rows above and under may stand right over it
  const free = (x, y, b, gap, loose = false) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && !onName(x, y) && !taken.some(t => (t.y === y && Math.abs(t.x - x) < gap) || (!loose && Math.abs(t.y - y) === 1 && Math.abs(t.x - x) < 2))
  const near = (x0, y0, b, gap, loose = false) => {
    for (let r = 0; r <= Math.max(W, H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -2 * r; dx <= 2 * r; dx++) {
          if (Math.abs(dy) !== r && Math.abs(dx) < 2 * r - 1) continue
          if (free(x0 + dx, y0 + dy, b, gap, loose)) return { x: x0 + dx, y: y0 + dy }
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
    // the dots above the name, round the middle of what the name leaves of the cell
    const box = { x0: sl.x + 1, x1: Math.max(sl.x + 1, sl.x + sl.w - 3), y0: sl.y, y1: Math.max(sl.y, nm.y - 1) }
    const cx = nm.x + nm.len / 2
    const cy = (box.y0 + box.y1) / 2
    const rx = Math.max(2, sl.w / 2 - 4)
    const ry = Math.max(1, (box.y1 - box.y0) / 2 + 0.5)
    const turn = hash(sl.g.id) * Math.PI * 2
    order.forEach((nd, i) => {
      // a few claims go round one ring, linked ones side by side; many fill the area round the name, a spiral out
      const a = k <= 10 ? turn + (Math.PI * 2 * i) / k : turn + i * 2.39996
      const f = k <= 2 ? 0.7 : k <= 10 ? 0.45 + 0.55 * hash(nd.id + '#') : 0.3 + 0.7 * Math.sqrt((i + 0.5) / k)
      const x0 = Math.round(cx + Math.cos(a) * rx * f)
      const y0 = Math.round(cy + Math.sin(a) * ry * f)
      // a crowded map (many claims in short cells): dots closer together, side by side, rather than one on another
      const got = near(x0, y0, box, 5) || near(x0, y0, box, 3) || near(x0, y0, box, 2) || near(x0, y0, all, 3) || near(x0, y0, all, 2) || near(x0, y0, all, 2, true) || { x: Math.max(0, Math.min(W - 2, x0)), y: Math.max(0, Math.min(H - 1, y0)) }
      taken.push(got)
      pos.set(nd.id, got)
    })
  })
  return { pos, names: names.map(({ id, name, lines, x, y, cell }) => ({ id, name, lines, x, y, cell })), h: H }
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
  ...(c.revised_by ? { revised_by: c.revised_by } : {}), ...(c.revises ? { revises: c.revises } : {}), ...(c.why ? { why: c.why } : {}),
  ...(c.because ? { because: c.because } : {}),
  ...(c.links && c.links.length ? { links: c.links.map(l => ({ to: l.to, how: l.how })) } : {}),
  sources: (c.sources || []).slice(0, 8),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row ?? null, by: s.by, turn: s.turn ?? null, quote: s.quote || '', sentence: s.sentence || '', ...(s.start != null ? { start: s.start, end: s.end } : {}), ...(s.ref ? { ref: s.ref } : {}) })),
})

/** The store as the pane reads it: its claims in the order listed (cluster by cluster), the groups with their colors'
 *  order, the edges, and the head's facts. */
export function paneData(store) {
  const view = viewOf({ clusters: [], gaps: [], ...(store || {}), claims: Array.isArray(store?.claims) ? store.claims : [] })
  const claims = view.flat.map(slim)
  const groups = view.groups.map((g, i) => ({ id: g.id ?? null, name: g.name, i, ...(g.about ? { about: g.about } : {}) }))
  return {
    total: view.total, clusters: view.clusters, last: view.last, gaps: (view.gaps || []).slice(-3),
    claims, groups, edges: edgesOf(view.flat),
  }
}

const num = c => Number(/\d+$/.exec(String(c.id))?.[0] || 0)

/** The key of a group (a cluster's id, `-` for the claims between clusters), and of the group a claim is in. */
export const groupKey = g => (g?.id == null || g.id === '' ? '-' : String(g.id))
export function claimGroup(data, c) {
  const k = String(c?.cluster)
  return (data.groups || []).some(g => g.id != null && String(g.id) === k) ? k : '-'
}

/** What the pane shows: the claim the state names, else the cluster it names; else, at rest, nothing chosen (`group`
 *  then the cluster of the newest correction of the last turn, else of the newest claim). New claims do not move the
 *  selection. {claim, group, chosen}: claim null while a cluster is chosen or at rest. */
export function selectedOf(data, st = {}) {
  const claims = data.claims || []
  if (!claims.length) return { claim: null, group: null, chosen: false }
  const byId = new Map(claims.map(c => [c.id, c]))
  const picked = st.claim ? byId.get(st.claim) : null
  if (picked) return { claim: picked, group: claimGroup(data, picked), chosen: true }
  if (st.group != null && (data.groups || []).some(g => groupKey(g) === String(st.group))) return { claim: null, group: String(st.group), chosen: true }
  const newest = claims.reduce((b, c) => ((c.turn ?? -1) > (b.turn ?? -1) || ((c.turn ?? -1) === (b.turn ?? -1) && num(c) > num(b)) ? c : b))
  const fixes = claims.filter(c => c.revises && c.turn != null && c.turn === newest.turn)
  const rest = fixes.length ? fixes.reduce((b, c) => (num(c) > num(b) ? c : b)) : newest
  return { claim: null, group: claimGroup(data, rest), chosen: false }
}

/** The claims that came in while the person browsed: the last look's, when it came after the selection (`st.at`, the
 *  last turn when it was made). They stay new until the next look. A Set of ids. */
export function freshOf(data, st = {}) {
  if (st.at == null || data.last == null || !(st.at < data.last)) return new Set()
  return new Set((data.claims || []).filter(c => c.turn === data.last).map(c => c.id))
}

/** The key of the cluster after or before the one given (n p), in `order` (the clusters' keys in reading order:
 *  graphView's `order`), else in the order the data lists them. No key (nothing chosen): n the first, p the last. */
export function hopCluster(orderOrData, key, dir) {
  const order = Array.isArray(orderOrData) ? orderOrData.map(String) : (orderOrData?.groups || []).map(groupKey)
  if (!order.length) return null
  const at = key == null ? -1 : order.indexOf(String(key))
  return order[at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length]
}

/** The rows of a cell of the map: four (two rows of dots and a name of two lines), taller while the map has room. */
export const CELL_ROWS = 7
export const CELL_MIN = 4
/** The share of the pane's rows the map may take; the detail under it has the rest. */
export const MAP_SHARE = 0.4
/** A pane this wide or wider has three columns of cells. */
const WIDE = 64

/** The map's columns of cells: two, three in a wide pane. */
export const mapColumns = W => (W >= WIDE ? 3 : 2)

/** The rows the map may take in a pane of H rows. */
const mapRows = H => Math.floor(H * MAP_SHARE)

/** How many clusters the map draws in a pane of W × H: its columns times the rows of the shortest cells (CELL_MIN) that
 *  fit in its share of the pane. */
export function mapCapacity(W, H) {
  return mapColumns(W) * Math.floor(mapRows(H) / CELL_MIN)
}

/** How many claims a cluster's cell holds legibly: one dot every three columns, in its two rows of dots. More
 *  clusters than the map holds (mapCapacity), or a cluster with more claims than this, and the map is too crowded to
 *  read: the pane lists the clusters one row each instead (clusterRows). */
export const cellSlots = W => Math.floor((Math.floor(W / mapColumns(W)) - 2) / 3) * (CELL_MIN - 2)
/** How many clusters that list holds: a row each, in half the pane. */
export const rowsCapacity = H => Math.max(2, Math.floor(H / 2))

/** Two clusters are near, and the map may draw them as one, when their claims are linked this many times, or their
 *  names and claims share this much of their words (store.js likeness). */
const NEAR_LINKS = 2
const NEAR_WORDS = 0.6
/** A merged cluster's two names joined are kept up to this length; past it, the larger's name and how many claims
 *  joined it. */
const JOINED_MAX = 80

/**
 * The data with at most `cap` groups where it can: while there are more, the smallest cluster (one-claim clusters
 * first; of two alike, the later listed) that is near another (NEAR_LINKS, NEAR_WORDS) joins the near one its claims
 * are linked to most, else whose name and claims share the most words with its own, a larger one first. When no two
 * are near and there are still more than `cap`, the largest keep their cells and the rest share the last one, named
 * for its largest and `+ N other clusters`: the map never draws more than it holds. The claims between clusters may
 * join one too; none joins them. Its claims take that cluster's id, its name says what it holds (both names joined,
 * or the larger's and `+ N other claims`), and the groups keep their order, numbered again for their colors. The
 * store is not changed: a larger pane shows the clusters apart again.
 */
export function fitClusters(data, cap) {
  const claims = data.claims || []
  const groups = (data.groups || []).map(g => ({ ...g, key: groupKey(g) }))
  const into = new Map()
  const root = k => { while (into.has(k)) k = into.get(k); return k }
  const home = c => root(claimGroup(data, c))
  const live = () => groups.filter(g => !into.has(g.key) && claims.some(c => home(c) === g.key))
  const byId = new Map(claims.map(c => [c.id, c]))
  const nameOf = k => groups.find(g => g.key === k)?.name || 'between clusters'
  let now = live()
  if (now.length <= Math.max(1, cap)) return data
  while (now.length > Math.max(1, cap)) {
    const size = new Map(now.map(g => [g.key, claims.filter(c => home(c) === g.key).length]))
    const textOf = k => [nameOf(k), ...claims.filter(c => home(c) === k).map(c => c.text)].join(' ')
    const linksOf = (a, b) => (data.edges || []).filter(e => byId.has(e.a) && byId.has(e.b) && (
      (home(byId.get(e.a)) === a && home(byId.get(e.b)) === b) || (home(byId.get(e.a)) === b && home(byId.get(e.b)) === a))).length
    // the smallest first; one near no other stays apart
    const order = now.slice().sort((p, q) => size.get(p.key) - size.get(q.key) || q.i - p.i)
    let joined = false
    for (const src of order) {
      const mine = textOf(src.key)
      const near = now.filter(g => g !== src && g.key !== '-').map(g => ({ g, links: linksOf(src.key, g.key), words: likeness(mine, textOf(g.key)) }))
        .filter(x => x.links >= NEAR_LINKS || x.words >= NEAR_WORDS)
      if (!near.length) continue
      const larger = near.filter(x => size.get(x.g.key) >= size.get(src.key))
      const pool = larger.length ? larger : near
      const score = x => [x.links, x.words, size.get(x.g.key), -x.g.i]
      const better = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }
      let best = pool[0], bs = score(best)
      for (const x of pool.slice(1)) { const sc = score(x); if (better(sc, bs)) { best = x; bs = sc } }
      into.set(src.key, best.g.key)
      joined = true
      break
    }
    if (!joined) break
    now = live()
  }
  // still more than the map holds: the largest keep their cells and the rest share the last one, so the map fits the
  // pane however far apart the clusters are (the claims between clusters keep a cell of their own)
  const rest = new Set()
  if (now.length > Math.max(1, cap)) {
    const size = k => claims.filter(c => home(c) === k).length
    const apart = now.filter(g => g.key !== '-').sort((p, q) => size(q.key) - size(p.key) || p.i - q.i)
    const cells = Math.max(1, cap - (now.length - apart.length))
    const host = apart[cells - 1]
    for (const g of apart.slice(cells)) into.set(g.key, host.key)
    rest.add(host.key)
    now = live()
  }
  if (!into.size) return data
  const keep = new Map(now.map(g => [g.key, g]))
  // a merged cluster's name: both names joined when short enough, else the larger's and how many claims joined it
  const named = k => {
    const parts = groups.filter(g => root(g.key) === k)
    if (parts.length < 2) return nameOf(k)
    const sized = parts.map(g => ({ name: nameOf(g.key), n: claims.filter(c => claimGroup(data, c) === g.key).length })).sort((p, q) => q.n - p.n)
    const both = sized.map(x => x.name).join(' + ')
    if (sized.length === 2 && len(both) <= JOINED_MAX) return both
    // clusters that share a cell only for room are said to be clusters, not claims of the larger one's question
    if (rest.has(k)) return `${sized[0].name} + ${sized.length - 1} other cluster${sized.length === 2 ? '' : 's'}`
    const others = sized.slice(1).reduce((a, x) => a + x.n, 0)
    return `${sized[0].name} + ${others} other claim${others === 1 ? '' : 's'}`
  }
  return {
    ...data,
    groups: (data.groups || []).filter(g => keep.has(groupKey(g))).map((g, i) => ({ ...g, name: named(groupKey(g)), i })),
    claims: claims.map(c => { const k = home(c); return k === claimGroup(data, c) ? c : { ...c, cluster: keep.get(k)?.id ?? null } }),
    merged: into.size,
  }
}

/** A claim's citations in the order the pane steps through them: the failed ones first. One x checks again (`repair`)
 *  keeps its place among them while it runs and after, so the pane goes on showing it. */
export function evidenceOf(c) {
  const srcs = c.sources || []
  const bad = s => s.status === 'failed' || !!s.repair
  return [...srcs.filter(bad), ...srcs.filter(s => !bad(s))]
}

/** What the side thread about the pane is about: the claim selected, the cluster selected, or the place a claim was
 *  said. Text a model reads. */
export function threadAbout(c, source = false, cluster = null) {
  if (!c && cluster) return `the claims of this session as a graph, in clusters; the cluster selected is "${cutWords(cluster.name, 160)}" (${cluster.n} claim${cluster.n === 1 ? '' : 's'})`
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

function layOf(claims, groups, edges, W, h, cols) {
  const order = claims.slice().sort((p, q) => (p.turn ?? 0) - (q.turn ?? 0) || num(p) - num(q))
  const named = groups.filter(g => g.id != null).map(g => ({ id: g.id, name: g.name }))
  const nodes = order.map(c => ({ id: c.id, cluster: c.cluster }))
  const key = JSON.stringify([W, h, cols, nodes, named, (edges || []).map(e => [e.a, e.b])])
  let got = LAYOUTS.get(key)
  if (!got) {
    got = spread(nodes, named, edges, { w: W, h, cols })
    LAYOUTS.set(key, got)
    if (LAYOUTS.size > MAX_LAYOUTS) LAYOUTS.delete(LAYOUTS.keys().next().value)
  }
  return got
}

// a citation's check as the citation's card says it beside `cite`: the sign and word, its tone; and as a chip under a
// claim counts it. Two outcomes: verified (a value the check corrected counts as verified; the claim says corrected),
// and failed (the check could not confirm it, or did not run); and the states before an outcome
const STATUS = {
  verified: ['✓ verified', 'good'], corrected: ['✓ verified', 'good'], failed: ['× failed', 'bad'],
  checking: ['checking', 'dim'], gone: ['no longer in the session', 'dim'],
}
// a status without an outcome (no check of it ran) is failed
const statusKey = s => (STATUS[s.status] ? s.status : 'failed')

/** Whether x can repair a citation: the check could not confirm it, or did not run (tray/tray.mjs canRepair). */
export const repairable = s => !!s && s.status === 'failed' && !!s.row && !!s.n

/** A line with spans of it tinted (the cited words), as runs; `rest` the look of the words outside them. */
export function tinted(text, spans = [], rest = {}) {
  const out = []
  let at = 0
  for (const [a, b] of spans.filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    if (a < at) continue
    if (a > at) out.push({ s: text.slice(at, a), ...rest })
    out.push({ s: text.slice(a, b), tint: true })
    at = b
  }
  if (at < text.length) out.push({ s: text.slice(at), ...rest })
  return out.length ? out : [{ s: ' ' }]
}

/** A line cut in the middle to n characters, ` … ` where it was cut. */
export function midCut(s, n) {
  const t = String(s ?? '')
  if (len(t) <= n || n < 9) return t
  const a = Array.from(t)
  const keep = n - 3
  const head = Math.ceil(keep * 0.6)
  return a.slice(0, head).join('').trimEnd() + ' … ' + a.slice(a.length - (keep - head)).join('').trimStart()
}

/** A line in pieces of at most n characters, with its spans moved into each piece. [{text, spans}] */
function pieces(text, spans, n) {
  const a = Array.from(String(text ?? ''))
  if (!a.length) return [{ text: '', spans: [] }]
  const out = []
  for (let i = 0; i < a.length; i += n) {
    const j = Math.min(a.length, i + n)
    out.push({ text: a.slice(i, j).join(''), spans: spans.map(([x, y]) => [Math.max(x, i) - i, Math.min(y, j) - i]).filter(([x, y]) => y > x) })
  }
  return out
}

/**
 * A citation's evidence as its card in the reply draws it (tray/tray.ts citationBody), in `room` characters: for a
 * value code computed, the one line of the code that printed it, cut in the middle, and the output line that holds it,
 * cut around the cited words, with how many output lines it leaves out; for a card's value, the card's title and the
 * header over the cited row when the value is a table's cell (`table`: the header and the row, tableLines), else the
 * line that holds it; for a file, its place and the cited line. The cited words' spans in the line. Null without
 * evidence. {code?, card?, table?, place?, text, spans, more, cut}: cut when the code or the line was cut.
 */
export function snippetOf(ev, room) {
  const line = evidenceLine(ev)
  if (!line) return null
  const fit = lineWindow(line, Math.max(9, room))
  const cutLine = fit.text !== line.text
  if (ev.kind === 'computed') {
    const code = printLine(ev.code, line.text)
    const shown = midCut(code, room)
    return { code: shown, text: fit.text, spans: fit.spans, more: hiddenOutput(ev), cut: cutLine || shown !== code }
  }
  if (ev.kind === 'card') {
    const table = ev.table ? tableLines(ev.table, Math.max(9, room)) : null
    return { card: one(ev.title || ev.card), ...(table ? { table } : {}), text: fit.text, spans: fit.spans, more: 0, cut: cutLine }
  }
  return { place: `${ev.file}:${line.n ?? ev.line}`, text: fit.text, spans: fit.spans, more: 0, cut: cutLine }
}

/** A citation's evidence whole, for c: every line of the code, then every output line (or the file's lines), each in
 *  pieces W wide, the cited words tinted. Rows of runs. */
function wholeRows(ev, W) {
  const rows = []
  const bar = (p, look = {}) => [{ s: '│', tone: 'dim-faint' }, { s: ' ' }, ...tinted(p.text || ' ', p.spans, look)]
  if (ev.kind === 'computed') {
    for (const l of String(ev.code || '').replace(/\n+$/, '').split('\n')) for (const p of pieces(l, [], W)) rows.push([{ s: p.text || ' ', tone: 'code' }])
    const hit = evidenceLine(ev)
    let found = false
    for (const l of String(ev.output || '').replace(/\n+$/, '').split('\n')) {
      const mine = !found && hit && l === hit.text
      if (mine) found = true
      for (const p of pieces(l, mine ? hit.spans : [], W - 2)) rows.push(bar(p))
    }
    return rows
  }
  if (ev.kind === 'card') {
    // a card's value: the card, then the cited cell's header and row (the columns round it that fit, as the reply's
    // card shows them: a table wrapped reads worse), else what its code printed, else the value
    rows.push(cardLine(ev, W))
    const table = ev.table ? tableLines(ev.table, W - 2) : null
    const lines = table || (ev.output != null ? [] : [evidenceLine(ev)].filter(Boolean))
    for (const l of lines) for (const p of pieces(l.text, l.spans, W - 2)) rows.push(bar(p))
    if (!table && ev.output != null) {
      const hit = evidenceLine(ev)
      let found = false
      for (const l of String(ev.output).replace(/\n+$/, '').split('\n')) {
        const mine = !found && hit && l === hit.text
        if (mine) found = true
        for (const p of pieces(l, mine ? hit.spans : [], W - 2)) rows.push(bar(p))
      }
    }
    return rows
  }
  rows.push([{ s: cut(`${ev.file}:${ev.line}`, W), tone: 'dim' }])
  for (const l of Array.isArray(ev.lines) ? ev.lines : []) for (const p of pieces(String(l.text ?? ''), l.highlight ? [l.highlight] : [], W - 2)) rows.push(bar(p))
  return rows
}

/** A card's value's first row, as the citation's card in the reply has it: `card` dim, then the card's title bold. */
const cardLine = (ev, W) => fit([{ s: 'card ', tone: 'dim' }, { s: one(ev.title || ev.card), bold: true }], W)

/**
 * A citation as its card in the reply draws it, as rows of runs W wide: the cited words bold in the citations' look
 * (underlined, tinted on hover; a failed one's red) and
 * its check beside them (`✓ verified · citation`); what it was, when the check corrected it, or why it failed, dim; then
 * its evidence (snippetOf): the code line in the code's color or the file's place dim, then the line after a dim │, the
 * cited words tinted (the rest dim where the line was cut), and `+ N more lines` under it when the output has more.
 * `whole`: the code and output whole (c). {rows, cut}: cut when the code or the line was cut.
 */
export function cardOf(s, W, { whole = false } = {}) {
  const key = statusKey(s)
  const [word, tone] = STATUS[key]
  // the kind in the tray's words (tray/tray.ts KINDS)
  const kind = ' · citation'
  const right = [{ s: '   ' }, { s: word, tone }, { s: kind, tone: 'dim' }]
  const words = one(s.shown || s.label)
  const look = key === 'failed' ? { tone: 'bad', underline: true } : { tint: true }
  const rows = [[{ s: cut(words, Math.max(8, W - 3 - len(word) - len(kind))), ...look, bold: true }, ...right]]
  const dim = t => wrap(t, W).forEach(l => rows.push([{ s: l, tone: 'dim' }]))
  if (s.status === 'corrected' && s.was) dim(`${s.rewritten ? 'sentence rewritten' : s.narrowed ? 'narrowed' : 'corrected'}; was ${one(s.was)}`)
  else if (s.status === 'failed' && s.reason) dim(firstSentence(s.reason))
  if (s.status === 'checking' || s.status === 'gone' || !s.evidence) return { rows, cut: false }
  if (whole) return { rows: [...rows, ...wholeRows(s.evidence, W)], cut: true }
  const sn = snippetOf(s.evidence, W - 2)
  if (!sn) return { rows, cut: false }
  if (sn.code) rows.push([{ s: sn.code, tone: 'code' }])
  if (sn.place) rows.push([{ s: cut(sn.place, W), tone: 'dim' }])
  if (sn.card != null) rows.push(cardLine(s.evidence, W))
  if (sn.table) {
    // a table's cell: the header over the cited row (and any other cited row), the cited cells tinted
    for (const l of sn.table) rows.push([{ s: '│', tone: 'dim-faint' }, { s: ' ' }, ...tinted(l.text || ' ', l.spans)])
    return { rows, cut: sn.cut }
  }
  const clipped = /^…|…$/.test(sn.text)
  rows.push([{ s: '│', tone: 'dim-faint' }, { s: ' ' }, ...tinted(sn.text, sn.spans, clipped ? { tone: 'dim' } : {})])
  if (sn.more) rows.push([{ s: '│', tone: 'dim-faint' }, { s: ' ' }, { s: moreLines(sn.more), tone: 'dim' }])
  return { rows, cut: sn.cut }
}

export const citationRows = (s, W) => cardOf(s, W).rows

// why a claim was wrong, as a check of its citations said it: the reason of one it failed or corrected
const checkWhy = c => (c?.sources || []).map(s => ((s.status === 'failed' || s.status === 'corrected') && s.reason ? s.reason : '')).find(Boolean) || ''

/**
 * A claim's corrections, oldest first, each {from, to, old, now, why, part}: each step of its history (historyOf), what
 * the earlier version said and what the later says, in their turns, and why it changed (the claims look's reason, kept
 * with the later claim, else the reason of the check that failed the earlier one's citation); and a citation the check
 * corrected, what it said before the check. `part`: a press selects the other version.
 */
export function correctionsOf(claim, byId) {
  const out = []
  const turn = c => (c.turn != null ? `turn ${c.turn}` : 'before')
  const chain = historyOf(claim, byId)
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i]
    const other = a.id === claim.id ? b : a
    out.push({ from: turn(a), to: turn(b), old: sentenceOf(a.text), now: sentenceOf(b.text), why: b.why || checkWhy(a), part: `was-${other.id}` })
  }
  for (const s of claim.sources || []) {
    if (s.status !== 'corrected' || !s.was) continue
    out.push({ from: turn(claim), to: 'the check', old: one(s.was), now: one(s.now || s.shown || s.label), why: s.reason || '', part: null })
  }
  return out.map(x => ({ ...x, why: x.why ? sentenceOf(x.why) : '' }))
}

/** A sentence's words, a full stop or comma after a word a token of its own (`glue`: no space before it). */
const tokens = t => one(t).split(' ').filter(Boolean).flatMap(w => {
  const m = /^(.*?[^.,;:!?])([.,;:!?]+)$/.exec(w)
  return m ? [{ s: m[1] }, { s: m[2], glue: true }] : [{ s: w }]
})

/**
 * The words of `a` and `b` compared: [{s, op, glue}] with op `same`, `del` (only in a) or `ins` (only in b), the
 * deleted words of a change before the inserted. Null when most words changed (a rewrite: show both whole).
 */
export function wordDiff(a, b) {
  const tx = tokens(a), ty = tokens(b)
  const x = tx.map(t => t.s), y = ty.map(t => t.s)
  const m = x.length, n = y.length
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  if (!m || !n || L[0][0] < 0.4 * Math.min(m, n)) return null
  const raw = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) { raw.push({ ...tx[i], op: 'same' }); i++; j++ } else if (j < n && (i >= m || L[i][j + 1] >= L[i + 1][j])) raw.push({ ...ty[j++], op: 'ins' })
    else raw.push({ ...tx[i++], op: 'del' })
  }
  // one word alike between two changes reads as part of one change: it goes into both
  const seq = []
  for (let k = 0; k < raw.length;) {
    if (raw[k].op !== 'same') { seq.push(raw[k++]); continue }
    let e = k
    while (e < raw.length && raw[e].op === 'same') e++
    const run = raw.slice(k, e)
    const lone = run.filter(t => !t.glue).length <= 1 && k > 0 && e < raw.length
    if (lone) for (const t of run) seq.push({ ...t, op: 'del' }, { ...t, op: 'ins' })
    else seq.push(...run)
    k = e
  }
  const out = []
  let dels = [], ins = []
  const flush = () => { out.push(...dels, ...ins); dels = []; ins = [] }
  for (const t of seq) {
    if (t.op === 'same') { flush(); out.push(t) } else (t.op === 'del' ? dels : ins).push(t)
  }
  flush()
  return out
}

const OP = { del: 'del', ins: 'ins', same: null }

/** Words with their ops wrapped to lines of at most n characters, as rows of runs: deleted words in the `del` tone
 *  (red, struck through), inserted in `ins` (green); the space between two words of one change takes its tone. */
function diffRows(words, n) {
  const rows = []
  let row = [], at = 0, prev = null
  words.forEach((w, k) => {
    // a word and the full stop glued after it go on one line
    const l = len(w.s) + (words[k + 1]?.glue ? len(words[k + 1].s) : 0)
    // a full stop stays on its word's line, with no space before it when the two are alike
    const glued = w.glue && at && (prev === w.op || (prev !== 'same' && w.op === 'same'))
    if (at && !glued && at + 1 + l > n) { rows.push(row); row = []; at = 0; prev = null }
    if (at && !glued) { row.push({ s: ' ', tone: prev && prev === w.op && w.op !== 'same' ? OP[w.op] : null }); at++ }
    row.push({ s: w.s, tone: OP[w.op] })
    at += len(w.s)
    prev = w.op
  })
  if (row.length) rows.push(row)
  return rows
}

/**
 * A claim's History, as rows W wide: each correction as `turn 2 → turn 3` (dim; a press selects the other version),
 * one word-level diff of the two versions, whole sentences (a rewrite shows the old one struck through, then the new),
 * and `reason: …` dim; a blank row between. All of them when `all` or two at most, oldest first; else the newest two,
 * newest first, and how many earlier ones h shows.
 */
export function historyRows(fixes, W, all = false) {
  if (!fixes.length) return []
  const rows = [[{ s: 'History', bold: true }]]
  const folded = !all && fixes.length > 2
  const shown = folded ? fixes.slice(-2).reverse() : fixes
  shown.forEach((x, k) => {
    if (k) rows.push([])
    rows.push([{ s: cut(`${x.from} → ${x.to}`, W), tone: 'dim', part: x.part }])
    const d = wordDiff(x.old, x.now)
    if (d) rows.push(...diffRows(d, W))
    else {
      for (const l of wrap(x.old, W)) rows.push([{ s: l, tone: 'del' }])
      for (const l of wrap(x.now, W)) rows.push([{ s: l, tone: 'ins' }])
    }
    if (x.why) for (const l of wrap(`reason: ${x.why}`, W)) rows.push([{ s: l, tone: 'dim' }])
  })
  if (folded) rows.push([], [{ s: `+ ${fixes.length - 2} earlier correction${fixes.length - 2 === 1 ? '' : 's'}`, tone: 'dim' }])
  return rows
}

/** One graph of the map's clusters on a canvas: their claims as solid dots in the cluster's color and their names under
 *  them in the same color, no lines. With a cluster or claim chosen, its cluster's dots and name are bold and every
 *  other dot and name `plain`: the theme's text color, not dim, so the map still reads on a light background. A new
 *  claim (`fresh`) is bold; the claim picked (`picked`) is inverse. A name is a press on its cluster (`g:<key>`), a dot
 *  a press on its claim (`d:<id>`). */
function graphOf({ data, claims, groups, edges, W, h, cols, group, tone, chosen, fresh, picked }) {
  const lay = layOf(claims, groups, edges, W, h, cols)
  const c = canvas(W, lay.h)
  const keyOf = id => (id === '' ? '-' : id)
  const toneOfGroup = k => toneOf((groups.find(g => groupKey(g) === k) || { i: 0 }).i)
  for (const nm of lay.names) {
    const k = keyOf(nm.id)
    const on = !chosen || k === group
    nm.lines.forEach((l, i) => c.text(nm.x, nm.y + i, [{ s: l, tone: on ? toneOfGroup(k) : 'plain', bold: chosen && on, part: `g:${k}` }]))
  }
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (!p) continue
    const mine = claimGroup(data, x) === group
    c.dot(p.x, p.y, DOT, !chosen || mine ? tone(x) : 'plain', { bold: (chosen && mine) || fresh.has(x.id), inverse: x.id === picked, part: `d:${x.id}` })
  }
  // a click lands on a blank cell beside a dot or a name too: a press of one cell alone is hard to hit
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (p) for (const dx of [-1, 1]) c.pad(p.x + dx, p.y, `d:${x.id}`)
  }
  for (const nm of lay.names) nm.lines.forEach((l, i) => { for (const x of [nm.x - 1, nm.x + len(l)]) c.pad(x, nm.y + i, `g:${keyOf(nm.id)}`) })
  return c
}

/** Runs cut to n cells, the last cut one ending in an ellipsis. */
function fit(runs, n) {
  const out = []
  let left = n
  for (const r of runs) {
    if (left <= 0) break
    const l = len(r.s)
    out.push(l <= left ? r : { ...r, s: cut(r.s, left) })
    left -= l
  }
  return out
}

/** What a cluster holds, after its name: how many claims. */
export function clusterWords(cs) {
  return `· ${cs.length} claim${cs.length === 1 ? '' : 's'}`
}

/** A group's name and claims. {g, name, cs} */
export function groupOf(data, key) {
  const g = (data.groups || []).find(x => groupKey(x) === String(key)) ?? null
  return { g, name: g ? g.name : 'between clusters', cs: (data.claims || []).filter(c => claimGroup(data, c) === String(key)) }
}

/** Words that compare alike: letters and digits, lower case. */
const fold = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Why a claim holds, as text and spans in it: the lens's `because` for it (one or two sentences, the message's
 * citation links in them), else the sentences of the reply that said it (`passage`: {md, place}), with the citations
 * that stand in them; when they only say the claim again, its citations stand in the claim's own words (`inClaim`,
 * spans of its sentence) where they are there. Each citation is the claim's source it names (`cite:<i>`, i its index in the claim's sources) in
 * the look citations have in the reply (`cite`: its status), and is a press that opens it as in the reply. The claim's
 * sources the text does not hold are `more`, each in that look. Null when there is nothing to show.
 * {text, spans: [{a, b, look}], more: {text, spans}, inClaim}
 */
export function reasonOf(claim, passage = null) {
  const srcs = claim?.sources || []
  const used = new Set()
  const inClaim = []
  const citeAt = (m, row, base) => {
    let i = srcs.findIndex((s, k) => !used.has(k) && row && s.row === row && s.at === base + m.start)
    if (i < 0) i = srcs.findIndex((s, k) => !used.has(k) && fold(s.label) === fold(m.words))
    if (i < 0) i = srcs.findIndex((s, k) => !used.has(k) && fold(m.words) && (fold(s.label).includes(fold(m.words)) || fold(m.words).includes(fold(s.label))))
    if (i >= 0) used.add(i)
    return i
  }
  // markdown as words, its citation links each a span of the words
  const read = (md, row = null, base = 0, table = false) => {
    const marks = marksIn(md)
    const p = plainOf(md)
    let text = ''
    const at = []
    for (let i = 0; i < p.plain.length; i++) {
      let ch = /\s/.test(p.plain[i]) ? ' ' : p.plain[i]
      if (table && ch === '|') {
        // a table row: its outer bars go, the others part its cells
        if (!text.trim() || !p.plain.slice(i + 1).trim()) continue
        ch = '·'
      }
      if (ch === ' ' && (!text || text.endsWith(' '))) continue
      text += ch
      at.push(p.at[i])
    }
    const spans = []
    for (const m of marks) {
      const a = at.findIndex(x => x >= m.start)
      if (a < 0) continue
      let b = a
      while (b < at.length && at[b] < m.end) b++
      const i = b > a ? citeAt(m, row, base) : -1
      if (i >= 0) spans.push({ a, b, look: { underline: true, cite: srcs[i].status || 'failed', part: `cite:${i}` } })
    }
    return { text: text.trim(), spans }
  }
  let out = null
  if (claim?.because) out = read(String(claim.because))
  else if (passage?.md && passage.place) {
    const s = String(passage.md)
    const span = spanOf(s, passage.place)
    const b = span ? blocks(s).find(x => x.type !== 'rule' && x.type !== 'code' && x.from <= span[0] && span[0] < x.to) : null
    if (b && b.type === 'table') {
      // a table: the row that holds the claim's words
      const from = s.lastIndexOf('\n', span[0]) + 1
      const end = s.indexOf('\n', span[0])
      const r = read(s.slice(from, end < 0 ? s.length : end), passage.place.row, from, true)
      out = r.text ? r : null
    } else if (b) {
      // the sentences of its block that hold the claim's words
      const body = s.slice(b.from, b.to)
      const cuts = [0, ...[...body.matchAll(/[.!?](?=\s+[\p{Lu}\p{N}"“(\[])/gu)].map(m => m.index + 1), body.length]
      let from = 0, to = body.length
      for (let k = 0; k + 1 < cuts.length; k++) {
        if (b.from + cuts[k + 1] <= span[0]) from = cuts[k + 1]
        if (b.from + cuts[k] >= span[1]) { to = cuts[k]; break }
      }
      const r = read(body.slice(from, to), passage.place.row, b.from + from)
      // sentences that only say the claim again: its citations stand in the claim's own words where they are there
      if (r.text && likeness(r.text, claim.text) >= 0.6) {
        used.clear()
        out = null
        const own = one(sentenceOf(claim.text))
        srcs.forEach((x, i) => {
          const w = one(x.shown || x.label).replace(/^["“”]+|["“”.]+$/g, '')
          const a = w ? own.toLowerCase().indexOf(w.toLowerCase()) : -1
          if (a < 0 || inClaim.some(y => y.a < a + w.length && a < y.b)) return
          used.add(i)
          inClaim.push({ a, b: a + w.length, look: { underline: true, cite: x.status || 'failed', part: `cite:${i}` } })
        })
      } else out = r.text ? r : null
    }
  }
  // the claim's citations the text does not hold: on a line of their own, ` · ` between them, the same words once
  const seen = new Set()
  const rest = srcs.map((s, i) => ({ s, i })).filter(x => !used.has(x.i) && one(x.s.shown || x.s.label) && !seen.has(fold(x.s.shown || x.s.label)) && seen.add(fold(x.s.shown || x.s.label)))
  let more = ''
  const moreSpans = []
  for (const { s, i } of rest) {
    more += more ? ' · ' : ''
    const a = more.length
    more += one(s.shown || s.label)
    moreSpans.push({ a, b: more.length, look: { underline: true, cite: s.status || 'failed', part: `cite:${i}` } })
  }
  if (!out && !more && !inClaim.length) return null
  return { text: out?.text || '', spans: out?.spans || [], more: { text: more, spans: moreSpans }, inClaim }
}

// ------------------------------------------------------------------------------------------------ the detail

/** The rule between the map and the detail. */
const ruleRow = W => [{ s: '─'.repeat(W), tone: 'dim-faint' }]

/** A heading as rows W wide: its words wrapped whole, bold (in `tone` when given), each row a press on `part`; `after`
 *  (dim) at the end of its last line, or on a row of its own when that line has no room for it. */
function headingRows(words, W, { tone = null, part = null, after = '' } = {}) {
  const lines = wrapName(words, W)
  if (!lines.length) lines.push('')
  const rows = lines.map(l => [{ s: l, ...(tone ? { tone } : {}), bold: true, part }])
  if (after && len(lines[lines.length - 1]) + 1 + len(after) <= W) rows[rows.length - 1].push({ s: ` ${after}`, tone: 'dim', part })
  else if (after) rows.push([{ s: after, tone: 'dim', part }])
  return rows
}

/** A cluster's orienting line under its name, plain words, three lines at most (then …). */
function aboutRows(about, W) {
  if (!about) return []
  let lines = wrap(about, Math.max(12, W))
  if (lines.length > 3) lines = [...lines.slice(0, 2), cutWords(lines.slice(2).join(' '), Math.max(12, W))]
  return lines.map(l => [{ s: l }])
}

/**
 * A cluster chosen, as rows W wide after the rule: its name bold in its color (a press on the cluster) and how many
 * claims, its orienting line, a blank row, then its claims one line each under it, numbered as the claim view counts
 * them (`1.`, `2.`, the number dim), cut after a whole word, then …, each a press that picks it (`n:<id>`); the current
 * one (`st.cur`, the first when none) whole, wrapped under its first word, `▸` and bold in the cluster's color; a new
 * one bold. A list taller than its room scrolls (scrollWindow, counting the claims out of view), the current claim
 * kept in view.
 * {rows, cur, curRow, curEnd}: the current claim's first and last rows
 */
function clusterPanel({ g, name, cs, group, tone, W, st, fresh }) {
  const part = `g:${group}`
  const rows = [ruleRow(W), ...headingRows(name, W, { tone, part, after: clusterWords(cs) }), ...aboutRows(g?.about, W), []]
  const cur = Math.max(0, Math.min(cs.length - 1, Number(st.cur) || 0))
  const numW = String(cs.length).length
  const lead = 2 + numW + 2
  const num = i => `${String(i + 1).padStart(numW)}. `
  let curRow = 0, curEnd = 0
  cs.forEach((c, i) => {
    const part = `n:${c.id}`
    if (i === cur) {
      // the current claim whole, wrapped under its first word
      const look = { tone, bold: true }
      curRow = rows.length
      wrap(sentenceOf(c.text), Math.max(8, W - lead)).forEach((l, k) => rows.push([{ s: k ? ' '.repeat(lead) : `▸ ${num(i)}`, ...look, part }, { s: l, ...look, part }]))
      curEnd = rows.length - 1
      return
    }
    const look = fresh.has(c.id) ? { bold: true } : {}
    rows.push([{ s: '  ', ...look, part }, { s: num(i), tone: 'dim', ...look, part }, { s: cutWords(sentenceOf(c.text), Math.max(8, W - lead)), ...look, part }])
  })
  return { rows, cur, curRow, curEnd }
}

/** How many claims of a cluster's list `hidden` rows hold that `shown` rows do not, as `N more claims`; null when they
 *  hold none (the window counts lines then). */
const claimsOutOfView = (hidden, shown) => {
  const ids = rs => new Set(rs.flatMap(r => r.map(x => x.part)).filter(p => /^n:/.test(p || '')))
  const seen = ids(shown)
  const n = [...ids(hidden)].filter(id => !seen.has(id)).length
  return n ? `${n} more claim${n === 1 ? '' : 's'}` : null
}

const FRAME = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', ml: '├', mr: '┤' }

/** One row inside a frame W wide: `│ `, the runs cut to the room inside, blanks to its right edge, ` │`. Every run a
 *  press on `part`. */
function framed(runs, W, tone, part) {
  const inner = Math.max(4, W - 4)
  const r = fit(runs, inner)
  const used = r.reduce((a, x) => a + len(x.s), 0)
  return [{ s: `${FRAME.v} `, tone, part }, ...r.map(x => ({ ...x, part })), { s: ' '.repeat(Math.max(0, inner - used)), part }, { s: ` ${FRAME.v}`, tone, part }]
}
const edge = (W, tone, part, [a, b]) => [{ s: a + FRAME.h.repeat(Math.max(0, W - 2)) + b, tone, part }]

/** A citation's words and its check at the right of `inner` cells: the words bold in the look citations have in the
 *  reply (`cite`), cut to leave room for the check. */
function citeTitle(s, inner) {
  const [word, tone] = STATUS[statusKey(s)]
  const words = cut(one(s.shown || s.label) || 'citation', Math.max(6, inner - len(word) - 2))
  return [{ s: words, cite: s.status || 'failed', bold: true }, { s: ' '.repeat(Math.max(2, inner - len(words) - len(word))) }, { s: word, tone }]
}

/** Where a citation's evidence is, in a few words: `computed`, the card's title, or the file's place. */
const whereOf = s => {
  const ev = s.evidence
  if (!ev) return ''
  if (ev.kind === 'computed') return 'computed'
  if (ev.kind === 'card') return `card ${one(ev.title || ev.card)}`
  return `${ev.file}:${evidenceLine(ev)?.n ?? ev.line}`
}

/** A citation on one line of `inner` cells: its words in the look citations have in the reply, and at the right its
 *  check's sign and where its evidence is (`✓ · saves.jsonl:41`). */
function citeLine(s, inner) {
  const key = statusKey(s)
  const tone = STATUS[key][1]
  const sign = { verified: '✓', corrected: '✓', failed: '×', checking: '…' }[key] ?? '·'
  const where = whereOf(s)
  const right = [{ s: sign, tone }, ...(where ? [{ s: ` · ${cut(where, Math.max(8, Math.floor(inner / 2) - 4))}`, tone: 'dim' }] : [])]
  const rl = right.reduce((a, x) => a + len(x.s), 0)
  const words = cut(one(s.shown || s.label) || 'citation', Math.max(6, inner - rl - 2))
  return [{ s: words, cite: s.status || 'failed' }, { s: ' '.repeat(Math.max(2, inner - len(words) - rl)) }, ...right]
}

/** A citation's card as the tray draws it, the rows inside its frame: its words and check (citeTitle), then what
 *  cardOf draws under them (what it was or why it failed, the code line or the file's place, the cited line after │),
 *  without the count of output lines left out; `whole`: the code and output whole. {rows, cut} */
function citeBody(s, inner, whole) {
  const card = cardOf(s, inner, { whole })
  const more = new RegExp(`^│ \\+ \\d+ more lines?$`)
  return { rows: [citeTitle(s, inner), ...card.rows.slice(1).filter(r => whole || !more.test(rowText(r)))], cut: card.cut }
}

/**
 * A claim's citations under it, as rows W wide (`cites`: evidenceOf's order, `cur` the current one). Not `compact`:
 * each a card in a frame of its own, the current one's frame in the accent color and the others' faint; a press on a
 * card opens it as a press on it in the reply does (`ev:<k>`). `compact`: one frame, the current card whole and each
 * other citation one line, its words and check, a press that makes it current (`at:<k>`). curRow: the current one's
 * first row. {rows, cut, curRow}
 */
function citeRows(cites, W, { cur, compact, whole }) {
  const inner = Math.max(4, W - 4)
  const rows = []
  let clipped = false, curRow = 0
  if (!compact) {
    cites.forEach((s, k) => {
      const tone = k === cur ? 'accent' : 'accent-faint'
      const part = `ev:${k}`
      const body = citeBody(s, inner, whole && k === cur)
      if (k === cur) { clipped = body.cut; curRow = rows.length }
      rows.push(edge(W, tone, part, [FRAME.tl, FRAME.tr]), ...body.rows.map(r => framed(r, W, tone, part)), edge(W, tone, part, [FRAME.bl, FRAME.br]))
    })
    return { rows, cut: clipped, curRow }
  }
  const tone = 'accent'
  rows.push(edge(W, tone, null, [FRAME.tl, FRAME.tr]))
  cites.forEach((s, k) => {
    if (k !== cur) { rows.push(framed(citeLine(s, inner), W, tone, `at:${k}`)); return }
    const body = citeBody(s, inner, whole)
    clipped = body.cut
    if (k > 0) rows.push(edge(W, tone, null, [FRAME.ml, FRAME.mr]))
    curRow = rows.length
    rows.push(...body.rows.map(r => framed(r, W, tone, `ev:${k}`)))
    if (k < cites.length - 1) rows.push(edge(W, tone, null, [FRAME.ml, FRAME.mr]))
  })
  rows.push(edge(W, tone, null, [FRAME.bl, FRAME.br]))
  return { rows, cut: clipped, curRow }
}

/**
 * A claim picked, as rows W wide (the map gone, the pane's whole height): `fixed`, the rows that stay on top while the
 * rest scrolls: its cluster's name in its color and which of its claims it is (a press on the cluster), with `about`
 * its orienting line, and a blank row; then `rows`: the claim, bold; for a
 * corrected claim one line that says so; a blank row and its description, plain (reasonOf: the lens's `because`, else
 * the reply's sentences that said it, without their citation marks); with `st.history`, its History (historyRows);
 * then a blank row and the line that shows its evidence (`evidence`: `show evidence (N citations)`, the pane's e),
 * and with `st.open` its citations under it (citeRows); or one dim line that says why it has none. curRow: the current
 * citation's first row in `rows`. {fixed, rows, cites, shown, cut, fixes, curRow}
 */
function claimPanel({ claim, W, byId, st, ctx, compact, cluster, about }) {
  const part = `g:${cluster.group}`
  const at = cluster.cs.findIndex(c => c.id === claim.id)
  const fixed = headingRows(cluster.name, W, { tone: cluster.tone, part, after: cluster.cs.length > 1 && at >= 0 ? `· ${at + 1} of ${cluster.cs.length}` : '' })
  if (about) fixed.push(...aboutRows(cluster.g?.about, W).map(r => r.map(x => ({ ...x, tone: 'dim', part }))))
  fixed.push([])
  const rows = wrap(sentenceOf(claim.text), W).map(l => [{ s: l, bold: true, part: `c:${claim.id}` }])
  const fixes = correctionsOf(claim, byId)
  if (fixes.length) rows.push([{ s: claim.revised_by ? 'corrected later' : fixes.length > 1 ? `corrected ×${fixes.length}` : 'corrected', tone: 'cite' }])
  const why = reasonOf(claim, ctx.passage)
  if (why?.text) rows.push([], ...wrap(why.text, W).map(l => [{ s: l }]))
  if (st.history && fixes.length) rows.push([], ...historyRows(fixes, W, true))
  const cites = evidenceOf(claim)
  if (!cites.length) {
    rows.push([], [{ s: claim.by === 'person' ? 'Your own words: not cited.' : 'No citation: the reply cites no record for it.', tone: 'dim' }])
    return { fixed, rows, cites: 0, shown: null, cut: false, fixes: fixes.length, curRow: 0 }
  }
  const cur = Math.max(0, Math.min(cites.length - 1, Number(st.cite) || 0))
  // its evidence hidden until e: a line that shows it (`evidence`, the pane's e), and hides it again
  const n = `${cites.length} citation${cites.length === 1 ? '' : 's'}`
  rows.push([], [{ s: st.open ? 'hide evidence' : `show evidence (${n})`, tone: 'accent', part: 'evidence' }])
  if (!st.open) return { fixed, rows, cites: cites.length, shown: null, cut: false, fixes: fixes.length, curRow: rows.length - 1 }
  rows.push([])
  const from = rows.length
  const got = citeRows(cites, W, { cur, compact, whole: !!st.whole })
  rows.push(...got.rows)
  return { fixed, rows, cites: cites.length, shown: cites[cur], cut: got.cut, fixes: fixes.length, curRow: from + got.curRow }
}

/**
 * The detail: the claim picked (claimPanel; `compact`: its citations one line each but the current one; `about`: its
 * cluster's orienting line), else the cluster chosen under the map (clusterPanel). {rows, cites, shown, cut, fixes,
 * curRow}
 */
export function panelOf({ data, claim, group, tone, W, byId = new Map((data.claims || []).map(c => [c.id, c])), st = {}, fresh = new Set(), ctx = {}, compact = false, about = true }) {
  const { g, name, cs } = groupOf(data, group)
  const gtone = tone(cs[0] || claim || {})
  if (claim) return claimPanel({ claim, W, byId, st, ctx, compact, about, cluster: { g, name, cs, group, tone: gtone } })
  const p = clusterPanel({ g, name, cs, group, tone: gtone, W, st, fresh })
  return { rows: p.rows, cites: 0, shown: null, cut: false, fixes: 0, curRow: p.curRow, curEnd: p.curEnd, unit: claimsOutOfView }
}

/**
 * The clusters one row each, when the map would be too crowded to read (cellSlots, mapCapacity) or the pane is
 * narrow: each its name (cut after a whole word, a press on the cluster) and its claims as a row of solid dots in its
 * color, a space between, each a press on its claim; `+N` when they do not all fit. The selection looks as on the map:
 * a cluster chosen, its name and dots bold in its color and every other in the text color; the current claim
 * (`picked`) inverse in its color.
 */
function clusterRows({ data, groups, W, group, chosen, fresh, picked }) {
  const nameW = Math.min(Math.max(...groups.map(g => len(g.name)), 6), Math.max(6, Math.floor(W * 0.45)))
  return groups.map(g => {
    const on = !chosen || g.key === group
    const tone = on ? toneOf(g.i) : 'plain'
    const part = `g:${g.key}`
    const name = cutWords(g.name, nameW)
    const row = [{ s: ' ', part }, { s: name, tone, bold: chosen && on, part }, { s: ' '.repeat(nameW - len(name) + 2), part }]
    const cs = groupOf(data, g.key).cs
    const room = Math.max(1, Math.floor((W - nameW - 3 - 4) / 2))
    const shown = cs.length > room ? cs.slice(0, room - 1) : cs
    shown.forEach((c, i) => {
      if (i) row.push({ s: ' ', part: `d:${c.id}` })
      row.push({ s: DOT, tone, bold: (chosen && on) || fresh.has(c.id), ...(c.id === picked ? { inverse: true } : {}), part: `d:${c.id}` })
    })
    if (shown.length < cs.length) row.push({ s: ` +${cs.length - shown.length}`, tone: 'dim', part })
    return row
  })
}

/** Rows a pane narrower than this lists its clusters one row each instead of the map. */
export const NARROW = 40
/** The rows the keys take under the detail: a rule and the keys' row. */
const KEYS_ROWS = 2

/** The groups with their claims' count, in the order listed: [{...group, key, n}], the empty ones left out. */
function counted(data) {
  const counts = new Map()
  for (const c of data.claims || []) counts.set(claimGroup(data, c), (counts.get(claimGroup(data, c)) || 0) + 1)
  return (data.groups || []).map(g => ({ ...g, key: groupKey(g), n: counts.get(groupKey(g)) || 0 })).filter(g => g.n)
}

/**
 * A detail taller than its `room` rows, scrolled: the window from row `top` (clamped), `↑ N more lines` in its first row
 * when rows are above it and `↓ N more lines` in its last when rows are under it, each a press that scrolls a page
 * (`sc:-1`, `sc:1`). `keep`: a row, or [first, last] rows, to bring into view (the current claim or citation), its
 * first row when not all fit. `unit(hidden, shown)`: what the rows out of view hold, in words (`5 more claims`), or
 * null for lines. {rows, top, max}: max the furthest top.
 */
export function scrollWindow(rows, room, top = 0, keep = null, unit = null) {
  const total = rows.length
  if (total <= room) return { rows, top: 0, max: 0 }
  const R = Math.max(3, room)
  const max = total - R + 1
  const span = t => {
    const from = t
    const k0 = R - (t > 0 ? 1 : 0)
    return [from, t + k0 >= total ? total : t + k0 - 1]
  }
  let t = Math.max(0, Math.min(max, Number(top) || 0))
  // its last row in view, then its first
  const [k0, k1] = Array.isArray(keep) ? keep : [keep, keep]
  if (k0 != null && k0 >= 0 && k0 < total) {
    while (t < max && Math.min(k1, total - 1) >= span(t)[1]) t++
    if (k0 < span(t)[0]) t = k0
  }
  const [from, to] = span(t)
  const out = []
  const shown = rows.slice(from, to)
  const words = hidden => unit?.(hidden, shown) || `${hidden.length} more line${hidden.length === 1 ? '' : 's'}`
  if (from > 0) out.push([{ s: `↑ ${words(rows.slice(0, from))}`, tone: 'dim', part: 'sc:-1' }])
  out.push(...shown)
  if (to < total) out.push([{ s: `↓ ${words(rows.slice(to))}`, tone: 'dim', part: 'sc:1' }])
  return { rows: out, top: t, max }
}

/**
 * The Claims pane as rows of runs, w × h cells (the rows the pane has, the keys' rule and row included). At rest and
 * with a cluster chosen: the head (at rest), the overview, then the detail under it (the cluster chosen: panelOf).
 * The overview is the map, in at most MAP_SHARE of the pane's rows, its cells as tall as that lets them be (seven
 * rows down to four); when the map would be too crowded to read (its cells do not fit in that share, or a cluster has
 * more claims than cellSlots) or the pane is narrow, the clusters one row each (clusterRows). A claim picked: the map
 * goes and the claim's detail takes the pane's whole height, its cluster fixed on top (its orienting line while
 * everything fits; with three citations or more that do not fit, the current one whole and the others one line
 * each). A detail taller than its room scrolls (scrollWindow). `st` = {claim, group, at, cur, open, cite, history,
 * whole, top, follow}: the claim picked, else the cluster chosen (its key), the last turn when it was chosen; with a
 * cluster, its current claim; with a claim, whether its evidence shows, its current citation, its History shown, the
 * current citation's code and output whole; `top` the detail's first row shown, `follow` to bring the current claim or citation into view. `bright`:
 * claims came in a moment ago.
 * Returns {head, graph, panel, scroll: {top, max, room}, claim, group, chosen, cites, shown, cut, fixes, compact,
 * rowsView, narrow, cellRows, data, order}; `data` the data as fitted; `order` the clusters' keys in reading order as
 * drawn (the map's cells row by row, left to right; a list top to bottom), the order p n walk. head, graph and panel
 * are rows of runs, a run's `part` what a press on it does (`g:<key>` a cluster, `d:<id>` a dot, `n:<id>` a claim of
 * the cluster, `sc:±1` a page of the detail, `ev:<k>` a citation's card, `at:<k>` a citation made current,
 * `was-<id>` another version of the claim).
 */
export function graphView(raw, st = {}, { w = 90, h = 40, bright = false, passage = null } = {}) {
  const ctx = { passage }
  const W = Math.max(24, w)
  const narrow = W < NARROW
  const H = Math.max(12, h)
  const all = counted({ ...raw, groups: raw.groups || [] })
  const crowded = narrow || all.length > mapCapacity(W, H) || all.some(g => g.n > cellSlots(W))
  const data = crowded ? fitClusters(raw, rowsCapacity(H)) : raw
  const claims = data.claims || []
  const byId = new Map(claims.map(c => [c.id, c]))
  const groups = data.groups || []
  const gi = new Map(groups.map(g => [String(g.id), g.i]))
  const tone = c => toneOf(gi.get(String(c.cluster)) ?? 0)
  const { claim, group, chosen } = selectedOf(data, st)
  const fresh = freshOf(data, st)
  // `+N new` for a moment: the claims that came in while browsing, else the last look's. The head shows at rest, and
  // with a cluster or claim chosen only while it says new claims came
  const added = bright ? fresh.size || claims.filter(c => c.turn != null && c.turn === data.last).length : 0
  const head = !chosen || added ? [headRuns(raw, { narrow, fresh: added })] : []
  for (const g of data.gaps || []) head.push([{ s: `Turn ${g.turn} was not read: `, tone: 'bad' }, { s: cut(g.why || 'the look at the answer failed', W - 24), tone: 'dim' }])
  const base = { claim, group, chosen, cites: 0, shown: null, cut: false, fixes: 0, compact: false, rowsView: crowded, narrow, cellRows: 0, data }
  if (!claims.length) return { head, graph: [], panel: [], scroll: { top: 0, max: 0, room: 0 }, ...base, order: [] }
  const mapped = counted(data)
  const order = mapped.map(g => g.key)
  const scrolled = (panel, room) => {
    const fixed = panel.fixed || []
    const win = scrollWindow(panel.rows, room - fixed.length, st.top, st.follow ? [panel.curRow, panel.curEnd ?? panel.curRow] : null, panel.unit)
    return { panel: [...fixed, ...win.rows], scroll: { top: win.top, max: win.max, room: room - fixed.length }, cites: panel.cites, shown: panel.shown, cut: panel.cut, fixes: panel.fixes }
  }
  if (claim) {
    // the claim alone, in the pane's whole height: its cluster's orienting line while everything fits, the citations
    // one line each but the current one when three or more do not fit
    const room = H - head.length - KEYS_ROWS
    const at = o => panelOf({ data, claim, group, tone, W, byId, st, fresh, ctx, ...o })
    const tries = [{ about: true, compact: false }, { about: false, compact: false }, { about: true, compact: true }, { about: false, compact: true }]
    let o = tries[0], panel = at(o)
    const tall = p => p.fixed.length + p.rows.length > room
    for (const t of tries.slice(1)) {
      if (!tall(panel) || (t.compact && panel.cites < 3)) break
      o = t
      panel = at(o)
    }
    return { head, graph: [], ...base, ...scrolled(panel, room), compact: o.compact, order }
  }
  const top = head.length + 1
  const picked = chosen ? (groupOf(data, group).cs[Math.max(0, Math.min(groupOf(data, group).cs.length - 1, Number(st.cur) || 0))]?.id ?? null) : null
  const detail = () => (chosen ? panelOf({ data, claim: null, group, tone, W, byId, st, fresh, ctx }) : null)
  const panel = detail()
  if (crowded) {
    const list = clusterRows({ data, groups: mapped, W, group, chosen, fresh, picked })
    const room = H - top - list.length - KEYS_ROWS
    return { head, graph: list, ...base, ...(panel ? scrolled(panel, room) : { panel: [], scroll: { top: 0, max: 0, room } }), order }
  }
  const cols = mapColumns(W)
  const cellRowsOf = Math.ceil(mapped.length / Math.min(cols, mapped.length))
  // the cells as tall as the map's share of the pane lets them be, seven rows down to four; the detail under it
  // scrolls
  const roomAt = c => H - top - c * cellRowsOf - KEYS_ROWS
  let ch = CELL_ROWS
  while (ch > CELL_MIN && ch * cellRowsOf > mapRows(H)) ch--
  const graph = graphOf({ data, claims, groups: mapped, edges: data.edges || [], W, h: ch * cellRowsOf, cols, group, tone, chosen, fresh, picked }).rows()
  // the clusters as the map draws them, row by row and left to right: the order p n walk
  const drawn = layOf(claims, mapped, data.edges || [], W, ch * cellRowsOf, cols).names.slice().sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x)
  const room = roomAt(ch)
  return { head, graph, ...base, ...(panel ? scrolled(panel, room) : { panel: [], scroll: { top: 0, max: 0, room } }), cellRows: ch, order: drawn.map(nm => (nm.id === '' ? '-' : nm.id)) }
}

/** The head: Claims and how many (`no claims yet` before the first), and `+N new` for a moment
 *  after claims came in. */
function headRuns(data, { narrow = false, fresh = 0 } = {}) {
  const n = data.total || 0
  const out = [{ s: 'Claims', bold: true }]
  if (!n) out.push({ s: ' · no claims yet', tone: 'dim' })
  else out.push({ s: ` · ${n.toLocaleString('en-US')}${narrow ? '' : ` claim${n === 1 ? '' : 's'}`}`, tone: 'dim' })
  if (fresh) out.push({ s: '  ' }, { s: `+${fresh} new`, bold: true })
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
  const said = c.said || []
  const first = said[0] || null
  const who = first ? (first.by === 'person' ? 'your message' : "Claude's message") : ''
  const lines = [[{ s: 'Where it was said', tone: 'c2', bold: true }, { s: `  ${who}`, tone: 'dim' }], []]
  const msg = first && text ? messageRows(text, first, W - 1) : null
  if (msg) msg.rows.forEach(r => lines.push(r.map(x => (x.on ? { s: x.s, tone: 'accent', bold: true } : { s: x.s }))))
  else if (first) lines.push([{ s: `“${cut(first.sentence || first.quote, W - 4)}”`, tone: 'accent', bold: true }])
  const again = said.slice(1)
  if (again.length) {
    lines.push([], [{ s: 'also said', tone: 'dim' }])
    for (const p of again) lines.push([...(p.by === 'person' ? [{ s: 'you ', tone: 'dim' }] : []), { s: `“${cut(p.sentence || p.quote, W - 8)}”` }])
  }
  return lines
}
