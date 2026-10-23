// graph.js: the Claims pane as pure functions over the conversation's claims (store.js): the map of clusters, the
// detail under it (the cluster chosen, or the claim picked in its list), and where a claim was said. No `$`, no DOM:
// pane.tsx draws what this returns with Claude Code's own elements, and the tests read it as text.
//
//   the head        Claims, how many and in how many clusters (`no claims yet` before the first); `+N new` bold for a
//                   moment after claims came in
//   the map         every cluster, each a loose group of dots in its own color in a cell of the map, its name under
//                   them (three lines at most, then …); a heavier dot is a claim said twice or more,
//                   a ◆ a claim that came in while the person browsed (until the next look).
//                   No lines join the dots, which keep their places while the person walks them. The map has two
//                   columns of cells (three in a wide pane) and as many rows of cells as fit over the room the detail
//                   keeps (cells of 4 rows); clusters beyond that, smallest first, join a near cluster (linked or
//                   sharing many words), its name then both names (fitClusters); clusters near no other stay apart.
//                   When the map or the detail needs the rows the cells get shorter, 7 rows down to 4; past that the
//                   pane scrolls.
//                   A narrow pane lists every cluster one per line
//   a short session fewer than FEW (10) claims: no map, since a few dots in one or two cells look sparse. The clusters
//                   are listed, each its name then its claims, a blank row between (listOf), with the selection, chips,
//                   evidence and keys of the detail; the map appears once there are FEW claims
//   the selection   at rest nothing is chosen. A press on a name, or p n, chooses a cluster: its dots and name bold in
//                   its color, every other in the text color. A press on a dot, or on a claim in the list, picks that claim
//   the detail      under the map, after a rule: the cluster's name and its claims, each after a dim – (two lines at
//                   most, then …), each a press that picks it; a window round the claim picked when they do not fit
//                   (`↑ N earlier`, `↓ N more · claims a–b of N`, each a press that pages by a screen). A claim picked is ▸ and bold in the cluster's color,
//                   whole, the others dim, and under it one line of chips (its citations' checks, `corrected ×N`, its
//                   turn). e keeps the claim alone and opens under it, for a corrected claim, its History (one
//                   word-level diff per correction and its reason; the newest two of more, h all), then its citations
//                   one at a time, the failed ones first, as the citation's card in the reply draws them (the cited
//                   words and the check, the code line that printed the value cut in the middle and the output line
//                   cut round the cited words, tinted, or the file's place and the line; c shows both whole), and which
//                   citation of how many (`‹ i of n ›`, ‹ and › a press that steps); a press on a citation opens its
//                   evidence pane. A citation is verified (a value the check corrected counts as verified) or failed
//                   (the check could not confirm it)
//   where it was said   the message that said the claim, its words marked, and the other places it was said
//
// A canvas (canvas()) is a grid of cells: text and dots that are parts (a press on the part; the blank cells beside a
// dot or a name are part of it). canvas.rows() gives each row as runs of {s, tone, bold, part}.
import { anchorTerm } from '../explain/place.mjs'
import { blocks, marksIn } from '../marks/message.js'
import { tableLines } from '../marks/table.mjs'
import { evidenceLine, firstSentence, hiddenOutput, lineWindow, moreLines, printLine } from '../tray/tray.mjs'
import { cutWords, edgesOf, findQuote, likeness, plainOf, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const len = s => Array.from(String(s ?? '')).length
/** A claim's words as a sentence: with its full stop. */
export const sentenceOf = s => one(s).replace(/([\p{L}\p{N}%)"'”’])$/u, '$1.')
/** The rows the panel under the graph keeps: a cluster and about fifteen of its claims, or a claim and its citations
 *  (more scroll). */
const PANEL = 17

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
/** Whether a claim cites no record: none of its words in the reply is a citation. */
export const uncited = c => !(c.sources || []).length
/** A claim's dot: filled, heavier when said twice or more (a claim a later one corrected stays filled); hollow when the
 *  claim cites no record. */
export const dotOf = c => (uncited(c) ? '○' : (c.n || 1) >= 2 ? '◉' : '●')

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
  const blank = () => ({ ch: ' ', tone: null, bold: false, part: null, fill: false })
  const cells = Array.from({ length: h }, () => Array.from({ length: w }, blank))
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
    /** A blank cell made part of a press beside it. */
    pad(x, y, part) { if (inside(x, y) && cells[y][x].ch === ' ' && !cells[y][x].part && !cells[y][x].fill) cells[y][x].part = part },
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
    // at most three lines (fewer in a short cell), the last ending after a whole word in … when the name goes on
    const most = Math.max(1, Math.min(3, sl.h - 1))
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
      const got = near(x0, y0, box, 5) || near(x0, y0, box, 3) || near(x0, y0, box, 2) || near(x0, y0, all, 3) || { x: Math.max(0, Math.min(W - 2, x0)), y: Math.max(0, Math.min(H - 1, y0)) }
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

/** The rows of a cell of the map: seven, down to four when the detail needs the rows. */
export const CELL_ROWS = 7
export const CELL_MIN = 4
/** The rows the map leaves the detail under it when it counts how many clusters it can draw: a claim picked with its
 *  evidence open (the rule, the cluster's name, a claim of three lines and its chips, a citation's card and the steps
 *  between citations), or a cluster's name and a few of its claims (the list pages past them). */
const DETAIL_MIN = 14
/** The rows above the map: the head and a blank row (the caption under the head shows only at rest, when no detail
 *  takes the rows under the map). */
const TOP_ROWS = 2
/** A pane this wide or wider has three columns of cells. */
const WIDE = 96

/** The map's columns of cells: two, three in a wide pane. */
export const mapColumns = W => (W >= WIDE ? 3 : 2)

/** How many clusters the map draws in a pane of W × H: its columns times the rows of the shortest cells (CELL_MIN) that
 *  fit over the room the detail keeps; two rows at least. Cells taller than that are drawn while they fit. */
export function mapCapacity(W, H) {
  return mapColumns(W) * Math.max(2, Math.floor((H - TOP_ROWS - KEYS_ROWS - DETAIL_MIN) / CELL_MIN))
}

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
const CHIP = [['good', '✓', 'verified'], ['bad', '×', 'failed'], ['checking', '…', 'checking'], ['dim', '·', 'not checked']]
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
 * its check beside them (`✓ verified · cite`); what it was, when the check corrected it, or why it failed, dim; then
 * its evidence (snippetOf): the code line in the code's color or the file's place dim, then the line after a dim │, the
 * cited words tinted (the rest dim where the line was cut), and `+ N more lines` under it when the output has more.
 * `whole`: the code and output whole (c). {rows, cut}: cut when the code or the line was cut.
 */
export function cardOf(s, W, { whole = false } = {}) {
  const key = statusKey(s)
  const [word, tone] = STATUS[key]
  const right = [{ s: '   ' }, { s: word, tone }, { s: ' · cite', tone: 'dim' }]
  const words = one(s.shown || s.label)
  const look = key === 'failed' ? { tone: 'bad', underline: true } : { tint: true }
  const rows = [[{ s: cut(words, Math.max(8, W - 3 - len(word) - 7)), ...look, bold: true }, ...right]]
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

/** What a claim's citations' checks found, as chips: `✓ 3 citations verified` when all are alike, else each status
 *  counted (`✓ 10 verified  × 2 failed`), each in its tone; `no citations` without. `short` (a narrow
 *  pane) leaves out `citations`. Runs, two spaces between. */
export function checkChips(c, { short = false } = {}) {
  const srcs = c.sources || []
  // no citation: why, in a few words (the analyst's own words are never cited)
  if (!srcs.length) return [{ s: c.by === 'person' ? 'your words, not cited' : 'no citation', tone: 'dim' }]
  const count = { good: 0, bad: 0, checking: 0, dim: 0 }
  for (const s of srcs) {
    const k = statusKey(s)
    count[k === 'checking' ? 'checking' : STATUS[k][1]]++
  }
  const kinds = CHIP.filter(([k]) => count[k]).length
  const out = []
  for (const [k, sign, word] of CHIP) {
    const n = count[k]
    if (!n) continue
    if (out.length) out.push({ s: '  ' })
    out.push({ s: `${sign} ${n}${kinds === 1 && !short ? ` citation${n === 1 ? '' : 's'}` : ''} ${word}`, tone: k === 'checking' ? 'dim' : k })
  }
  return out
}

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

/**
 * A claim's evidence, opened under it with e, as rows W wide: a blank row, for a corrected claim its History
 * (historyRows) and a blank row, then one citation as its card draws it (cardOf; a press opens its evidence pane,
 * `ev-N`), a blank row and which citation of how many, `‹ i of n ›` (with more than one, ‹ a press on the one before,
 * `cite-prev`, › on the next, `cite-next`). `st`: {cite, all, whole}. {rows, cites, shown, cut, fixes}
 */
export function evidenceRows(claim, byId, W, st = {}) {
  const rows = [[]]
  const fixes = correctionsOf(claim, byId)
  if (fixes.length) rows.push(...historyRows(fixes, W, !!st.all), [])
  const evidence = evidenceOf(claim)
  const i = Math.max(0, Math.min(evidence.length - 1, Number(st.cite) || 0))
  const s = evidence[i] || null
  let clipped = false
  if (s) {
    const part = s.row && s.n ? `ev-${i + 1}` : null
    const card = cardOf(s, W, { whole: !!st.whole })
    clipped = card.cut
    for (const r of card.rows) rows.push(r.map(x => ({ ...x, part })))
    const step = evidence.length > 1
    rows.push([], [
      { s: '‹', tone: 'accent', part: step ? 'cite-prev' : null }, { s: ' ' }, { s: `${i + 1} of ${evidence.length}`, tone: 'dim' }, { s: ' ' },
      { s: '›', tone: 'accent', part: step ? 'cite-next' : null },
    ])
  } else if (fixes.length) rows.pop()
  return { rows, cites: evidence.length, shown: s, cut: clipped, fixes: fixes.length }
}

/** One graph of the map's clusters on a canvas: their claims as dots in the cluster's color and their names under them
 *  in the same color, no lines. With a cluster or claim chosen, its cluster's dots and name are bold and every other
 *  dot and name `plain`: the theme's text color, not dim, so the map still reads on a light background. New claims (`fresh`) are ◆, bold in their color. A name is a press on its cluster (`g:<key>`), a
 *  dot a press on its claim (`d:<id>`). */
function graphOf({ data, claims, groups, edges, W, h, cols, group, tone, chosen, fresh }) {
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
    if (fresh.has(x.id)) c.dot(p.x, p.y, '◆', tone(x), { bold: true, part: `d:${x.id}` })
    else c.dot(p.x, p.y, dotOf(x), !chosen || mine ? tone(x) : 'plain', { bold: chosen && mine, part: `d:${x.id}` })
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

// ------------------------------------------------------------------------------------------------ styled words

/** Words wrapped to lines of at most n characters, each line with the offset of its first character in `text`: [{s,
 *  at}]. Runs of white space are one space (`text` is one line already: one()); a word longer than n goes on over the
 *  next lines. */
function wrapAt(text, n) {
  const out = []
  let cur = null
  for (const m of String(text).matchAll(/\S+/g)) {
    let w = m[0], at = m.index
    if (cur && len(cur.s) + 1 + len(w) <= n) { cur.s += ' ' + w; continue }
    if (cur) out.push(cur)
    while (len(w) > n) { out.push({ s: w.slice(0, n), at }); w = w.slice(n); at += n }
    cur = { s: w, at }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * The words a pane shows a session's explainers on: where each term stands in `text`, as written or in another form
 * of its words ("public hit counter" in "public hit counters"; explain/place.mjs anchorTerm), never on a small word
 * alone. `terms`: [{term, key}]. [{a, b, key}] in text order, none overlapping.
 */
export function termSpans(text, terms = []) {
  const out = []
  for (const t of terms) {
    const hit = anchorTerm(text, t.term, out.map(x => ({ start: x.a, end: x.b })))
    if (hit && hit.how !== 'word') out.push({ a: hit.start, b: hit.end, key: t.key })
  }
  return out.sort((x, y) => x.a - y.a)
}

/** A run of a term that has an explainer: the explainers' fill (pane.tsx draws `bg: 'gloss'`), a press that opens it
 *  under the claim `id` (`x:[id, key]`). */
export const termLook = (key, id = null) => ({ bg: 'gloss', part: `x:${JSON.stringify([id, key])}` })

/**
 * One line of words as rows n wide, each a list of runs: `base` the look of every run, `spans` [{a, b, look}] the
 * looks of stretches of the text over it (a later span over an earlier one). A run's part is the span's, else `base`'s.
 */
export function styledRows(text, n, base = {}, spans = []) {
  const t = one(text)
  const merged = spans.map(x => ({ a: x.a, b: x.b, l: { ...base, ...x.look } }))
  const lookAt = i => {
    let l = base
    for (const x of merged) if (i >= x.a && i < x.b) l = x.l
    return l
  }
  return wrapAt(t, n).map(line => {
    const runs = []
    Array.from(line.s).forEach((ch, k) => {
      const at = line.at + k
      // a space between two words of one stretch takes its look; any other space the base's
      const l = ch === ' ' ? (lookAt(at - 1) === lookAt(at + 1) ? lookAt(at - 1) : base) : lookAt(at)
      const last = runs[runs.length - 1]
      if (last && last.l === l) last.s += ch
      else runs.push({ s: ch, l })
    })
    // the lines are split on words in a one-spaced copy: the offsets hold, since `text` is passed one-spaced
    return runs.map(r => ({ ...r.l, s: r.s }))
  })
}

/** A cluster's orienting line under its name, dim, three lines at most, each a press on `part`. */
function aboutRows(about, W, part) {
  if (!about) return []
  let lines = wrap(about, Math.max(12, W - 4))
  if (lines.length > 3) lines = [...lines.slice(0, 2), cutWords(lines.slice(2).join(' '), Math.max(12, W - 4))]
  return lines.map(l => [{ s: '  ', part }, { s: l, tone: 'dim', part }])
}

/** A cluster's name over its list, as rows W wide, each a press on `part`. Chosen alone (`lit`): `● name` bold in the
 *  cluster's color; above a claim: the dot in the color and the name bold; `dim` (another cluster is chosen): all dim.
 *  The name is whole, wrapped (never cut), and `after` (dim) follows it, on a row of its own when the last line has
 *  no room for it. */
function nameRows(name, tone, W, { after = '', part = null, lit = false, dim = false, narrow = false, about = '' } = {}) {
  const room = narrow ? Math.max(8, W - 2) : Math.max(12, W - 14)
  const lines = wrapName(name, room)
  if (!lines.length) lines.push('')
  const look = lit ? { tone, bold: true } : dim ? { tone: 'dim' } : { bold: true }
  const rows = lines.map((l, i) => [{ s: i ? '  ' : '● ', ...(i ? {} : lit ? { tone, bold: true } : { tone: dim ? 'dim' : tone }), part }, { s: l, ...look, part }])
  if (after && 2 + len(lines[lines.length - 1] ?? '') + 1 + len(after) <= W) rows[rows.length - 1].push({ s: ` ${after}`, tone: 'dim', part })
  else if (after) rows.push([{ s: '  ', part }, { s: after, tone: 'dim', part }])
  // its orienting line under it, when its cluster is shown alone or the list has room for every cluster's
  if (about && !dim) rows.push(...aboutRows(about, W, part))
  return rows
}

/** A claim in the cluster's list, as rows W wide, each a press on `part`: `–` and its sentence, wrapped under its first
 *  word, whole when `whole`, else two lines at most (then …). The claim picked: `▸` and the whole sentence bold in the
 *  cluster's color; with a claim picked, every other one dim; a new claim (`fresh`) bold. */
function itemRows(c, W, { tone, picked = false, dim = false, fresh = false, part = null, whole = false, terms = [] }) {
  const look = picked ? { tone, bold: true } : fresh ? { bold: true } : dim ? { tone: 'dim' } : {}
  let text = one(sentenceOf(c.text))
  const plain = wrap(text, W - 4)
  if (!picked && !whole && plain.length > 2) {
    // two lines at most, the second cut after a whole word, then …: a prefix of the sentence, so its terms keep their
    // places
    const words = plain[1].split(' ')
    while (words.length > 1 && len(words.join(' ')) + 2 > W - 4) words.pop()
    text = `${plain[0]} ${words.join(' ')} …`
  }
  // the terms that have an explainer this session: in the explainers' fill, each a press that opens it
  const lines = styledRows(text, W - 4, { ...look, part }, termSpans(text, terms).map(x => ({ a: x.a, b: x.b, look: termLook(x.key, c.id) })))
  // a claim that cites no record: a hollow marker, as its dot on the map
  const mark = picked ? '▸ ' : uncited(c) ? '◦ ' : '– '
  return lines.map((l, i) => (i
    ? [{ s: '    ', part }, ...l]
    : [{ s: '  ', part }, { s: mark, ...(picked || fresh ? look : { tone: 'dim' }), part }, ...l]))
}


/**
 * The paragraph of the reply a claim came from (the block of `md` that holds its place), as the person reads it, in
 * rows n wide after a dim `▎ `: the claim's own words in the text's color, the rest dim; a citation's words underlined,
 * each a press that explains them (`w:<k>`, k its index among `words`); the terms that have an explainer in their fill,
 * each a press that opens it (`x:<key>`). At most `max` rows, round the claim's words, `…` where it was cut.
 * {rows, words}: `words` the citations' words as the person reads them. Null when the place is not in `md`.
 */
export function passageRows(md, place, n, { terms = [], max = 5, claim = null } = {}) {
  const s = String(md || '')
  if (!s || !place) return null
  const span = spanOf(s, place)
  if (!span) return null
  const b = blocks(s).find(x => x.type !== 'rule' && x.type !== 'code' && x.from <= span[0] && span[0] < x.to)
  if (!b) return null
  const p = plainOf(s.slice(b.from, b.to))
  // the plain text one-spaced, with each kept character's markdown offset
  let text = ''
  const at = []
  for (let i = 0; i < p.plain.length; i++) {
    const ch = /\s/.test(p.plain[i]) ? ' ' : p.plain[i]
    if (ch === ' ' && (!text || text.endsWith(' '))) continue
    text += ch
    at.push(p.at[i] + b.from)
  }
  while (text.endsWith(' ')) { text = text.slice(0, -1); at.pop() }
  if (!text) return null
  const range = (x, y) => {
    const a = at.findIndex(m => m >= x)
    if (a < 0) return null
    let e = a
    while (e < at.length && at[e] < y) e++
    return e > a ? { a, b: e } : null
  }
  const spans = []
  const own = range(span[0], span[1])
  if (own) spans.push({ ...own, look: { tone: null } })
  const words = []
  for (const m of marksIn(s)) {
    if (m.start < b.from || m.end > b.to) continue
    const r = range(m.start, m.end)
    if (!r) continue
    spans.push({ ...r, look: { underline: true, part: `w:${words.length}` } })
    words.push(text.slice(r.a, r.b))
  }
  for (const t of termSpans(text, terms)) spans.push({ a: t.a, b: t.b, look: termLook(t.key, claim) })
  let rows = styledRows(text, Math.max(10, n - 2), { tone: 'dim' }, spans)
  if (rows.length > max) {
    // the window round the claim's words
    const lineOf = i => { let k = 0, used = 0; for (const r of rows) { used += r.reduce((a, x) => a + len(x.s), 0) + 1; if (used > i) return k; k++ } return rows.length - 1 }
    const from = Math.max(0, Math.min(own ? lineOf(own.a) - 1 : 0, rows.length - max))
    const cutTop = from > 0, cutEnd = from + max < rows.length
    rows = rows.slice(from, from + max)
    if (cutTop) rows[0] = [{ s: '… ', tone: 'dim' }, ...rows[0]]
    if (cutEnd) rows[rows.length - 1] = [...rows[rows.length - 1], { s: ' …', tone: 'dim' }]
  }
  return { rows: rows.map(r => [{ s: '▎ ', tone: 'dim' }, ...r]), words }
}

/** An explainer shown in place under a claim (`ex`: {term, body, here} once written; {term, pending} while it is
 *  written on demand; {term, why} when it was not), as rows n wide: the term bold in the explainers' fill and `explainer`
 *  dim, then its body, then where it mattered, dim (its links read as their words). */
export function explainerRows(ex, n) {
  if (!ex) return []
  const w = Math.max(10, n - 2)
  const head = [{ s: '▎ ', tone: 'dim' }, { s: one(ex.term), bold: true, bg: 'gloss' }, { s: '  explainer', tone: 'dim' }]
  if (ex.pending) return [head, [{ s: '▎ ', tone: 'dim' }, { s: 'writing an explainer of these words…', tone: 'dim' }]]
  if (ex.why) return [head, ...wrap(ex.why, w).map(l => [{ s: '▎ ', tone: 'dim' }, { s: l, tone: 'bad' }])]
  const words = t => one(String(t || '').replace(/\[([^\]\n]+)\]\([^()\s]*\)/g, '$1').replace(/[`*]/g, ''))
  const rows = [head, ...wrap(words(ex.body), w).map(l => [{ s: '▎ ', tone: 'dim' }, { s: l }])]
  if (ex.here) rows.push(...wrap(words(ex.here), w).map(l => [{ s: '▎ ', tone: 'dim' }, { s: l, tone: 'dim' }]))
  return rows
}

/** A claim's first citation as its card draws it (cardOf), short: its words and check, why it failed or what it was,
 *  and the line of its evidence; each row a press that opens its evidence pane (`ev-1`). */
function firstCiteRows(claim, W) {
  const s = evidenceOf(claim)[0]
  if (!s) return []
  const part = s.row && s.n ? 'ev-1' : null
  return cardOf(s, W).rows.slice(0, 4).map(r => r.map(x => ({ ...x, part })))
}

/**
 * A claim picked in the list, as rows W wide: the claim (itemRows: `▸`, whole, bold in its cluster's color), its chips
 * (chipRuns, with which claim of how many it is), and, with its evidence closed, what it came from: the paragraph of
 * the reply that said it (passageRows), the explainer asked for in place (explainerRows) and its first citation
 * (firstCiteRows). `ctx`: {terms, passage: {md, place}, explainer}.
 */
function pickedOf(c, { tone, W, fixes, narrow, cs = [], st = {}, ctx = {} }) {
  const at = cs.findIndex(x => x.id === c.id)
  const place = cs.length > 1 && at >= 0 ? { i: at + 1, n: cs.length } : null
  const rows = [...itemRows(c, W, { tone, picked: true, part: `c:${c.id}`, terms: ctx.terms || [] }), fit([{ s: '    ' }, ...chipRuns(c, fixes, narrow, place)], W)]
  if (st.open) return rows
  // why a claim of Claude's has no citation: the reply cites no record for it, so nothing checked it
  if (uncited(c) && c.by !== 'person') rows.push(...wrap('The reply cites no record for this claim, so thimble did not check it.', W - 4).map(l => [{ s: '    ' }, { s: l, tone: 'dim' }]))
  const pass = ctx.passage ? passageRows(ctx.passage.md, ctx.passage.place, W - 4, { terms: ctx.terms || [], claim: c.id }) : null
  if (pass) rows.push(...indent(pass.rows, 4))
  rows.push(...indent(explainerRows(ctx.explainer, W - 4), 4))
  rows.push(...indent(firstCiteRows(c, W - 4), 4))
  return rows
}

/** Rows indented by n cells. */
const indent = (rows, n) => rows.map(r => (r.length ? [{ s: ' '.repeat(n), part: r[0].part ?? null }, ...r] : r))

/** The chips under a picked claim: its citations' checks (checkChips), `corrected ×N` (or `corrected later`), its
 *  turn. Runs. */
function chipRuns(claim, fixes, short, place = null) {
  const chips = [...(place ? [{ s: `claim ${place.i} of ${place.n}`, tone: 'dim' }, { s: '  ' }] : []), ...checkChips(claim, { short })]
  if (fixes) chips.push({ s: '  ' }, { s: claim.revised_by ? 'corrected later' : fixes > 1 ? `corrected ×${fixes}` : 'corrected', tone: 'cite' })
  const when = whenOf(claim)
  if (when) chips.push({ s: '  ' }, { s: when, tone: 'dim' })
  return chips
}

/**
 * The detail under the map, as rows W wide, after a rule: the cluster's name (nameRows; a press selects the cluster,
 * `g:<key>`) and its claims (itemRows; a press selects one, `n:<id>`). With a claim picked the list stays: the claim `▸`
 * and bold in the cluster's color, the others dim, and under it one line of chips (chipRuns). With `open` only the
 * claim stays, its evidence under it (evidenceRows). The list keeps to `room` rows: past that, a window round the claim
 * picked (from `st.from`, the first claim it shows, once the person paged), `↑ N earlier` above it and `↓ N more ·
 * claims a–b of N` under it, each a press that pages by a screen (`pg:<first claim of that screen>`).
 * {rows, cites, shown, cut, fixes, windowed}
 */
export function panelOf({ data, claim, group, tone, W, byId = new Map((data.claims || []).map(c => [c.id, c])), room = 16, st = {}, fresh = new Set(), narrow = false, ctx = {} }) {
  const { g, name, cs } = groupOf(data, group)
  const gtone = tone(cs[0] || claim || {})
  const rows = [[{ s: '─'.repeat(W), tone: 'dim-faint' }], ...nameRows(name, gtone, W, { after: clusterWords(cs), part: `g:${group}`, lit: !claim, narrow, about: g?.about || '' })]
  const fixes = claim ? correctionsOf(claim, byId).length : 0
  const pickedRows = c => pickedOf(c, { tone: gtone, W, fixes, narrow, cs, st, ctx })
  if (claim && st.open) {
    const ev = evidenceRows(claim, byId, W - 4, st)
    rows.push(...pickedRows(claim), ...indent(ev.rows, 4))
    return { rows, cites: ev.cites, shown: ev.shown, cut: ev.cut, fixes, windowed: false }
  }
  const itemsOf = whole => cs.map(c => (claim?.id === c.id ? pickedRows(c) : itemRows(c, W, { tone: gtone, dim: !!claim, fresh: fresh.has(c.id), part: `n:${c.id}`, whole, terms: ctx.terms || [] })))
  const budget = Math.max(3, room - rows.length)
  const height = its => its.reduce((a, r) => a + r.length, 0)
  // each claim whole when they all fit the room, else two lines at most, so a claim is cut only when the room is short
  const full = itemsOf(true)
  const items = height(full) <= budget ? full : itemsOf(false)
  // the window of claims the list shows: all when they fit, else round the claim picked (or from the first), or from
  // the claim the person paged to
  const all = height(items)
  const fitIn = budget - 2
  // the claims a screen shows from claim `a` down
  const downFrom = a => { let b = a, used = 0; while (b < items.length && (b === a || used + items[b].length <= fitIn)) { used += items[b].length; b++ } return b }
  // the first claim of the screen that ends just above claim `b`
  const upFrom = b => { let a = b, used = 0; while (a > 0 && (a === b || used + items[a - 1].length <= fitIn)) { a--; used += items[a].length } return a }
  let lo = 0, hi = items.length
  if (all > budget) {
    const from = Number(st.from)
    if (Number.isInteger(from) && from >= 0 && from < items.length) {
      lo = from; hi = downFrom(lo)
      // the last screen ends with the last claim
      if (hi === items.length) lo = upFrom(items.length)
    } else {
      const at = Math.max(0, claim ? cs.findIndex(c => c.id === claim.id) : 0)
      lo = at; hi = at + 1
      let used = items[at]?.length || 0
      for (let grew = true; grew;) {
        grew = false
        // a few claims above the one picked, then the ones under it, then the rest above
        if (lo > 0 && at - lo < Math.min(3, Math.floor(fitIn / 3)) && used + items[lo - 1].length <= fitIn) { lo--; used += items[lo].length; grew = true; continue }
        if (hi < items.length && used + items[hi].length <= fitIn) { used += items[hi].length; hi++; grew = true; continue }
        if (lo > 0 && used + items[lo - 1].length <= fitIn) { lo--; used += items[lo].length; grew = true }
      }
    }
  }
  const windowed = lo > 0 || hi < items.length
  if (lo > 0) rows.push([{ s: `  ↑ ${lo} earlier`, tone: 'dim', part: `pg:${upFrom(lo)}` }])
  for (let i = lo; i < hi; i++) rows.push(...items[i])
  if (windowed) {
    const down = hi < items.length ? `pg:${hi}` : null
    rows.push([{ s: `  ${hi < items.length ? `↓ ${items.length - hi} more · ` : ''}claims ${lo + 1}–${hi} of ${items.length}`, tone: 'dim', part: down }])
  }
  return { rows, cites: claim ? evidenceOf(claim).length : 0, shown: null, cut: false, fixes, windowed }
}

/**
 * A short session's clusters in place of the map (fewer than FEW claims), as rows W wide after a rule: each cluster's
 * name (nameRows; a press chooses it, `g:<key>`) then its claims (itemRows; a press picks one, `n:<id>`), a blank row
 * between clusters. The selection is as under the map: a cluster chosen, its name `● name` bold in its color and every
 * other cluster dim; a claim picked, `▸` and bold in its cluster's color with its chips under it (a press on it chooses
 * its cluster), every other claim and cluster dim; with `open` only its cluster's name and the claim stay, its evidence
 * under it (panelOf). The list has no window: a list taller than the pane scrolls. {rows, cites, shown, cut, fixes,
 * windowed}
 */
export function listOf({ data, claim, group, chosen, tone, W, byId = new Map((data.claims || []).map(c => [c.id, c])), st = {}, fresh = new Set(), narrow = false, ctx = {} }) {
  if (claim && st.open) return panelOf({ data, claim, group, tone, W, byId, st, fresh, narrow, ctx })
  const fixes = claim ? correctionsOf(claim, byId).length : 0
  const rows = [[{ s: '─'.repeat(W), tone: 'dim-faint' }]]
  for (const g of counted(data)) {
    const cs = groupOf(data, g.key).cs
    const gtone = toneOf(g.i)
    const mine = chosen && g.key === group
    if (rows.length > 1) rows.push([])
    rows.push(...nameRows(g.name, gtone, W, { after: clusterWords(cs), part: `g:${g.key}`, lit: mine && !claim, dim: chosen && !mine, narrow, about: g.about || '' }))
    for (const c of cs) {
      if (claim?.id === c.id) rows.push(...pickedOf(c, { tone: gtone, W, fixes, narrow, cs, st, ctx }))
      else rows.push(...itemRows(c, W, { tone: gtone, dim: !!claim || (chosen && !mine), fresh: fresh.has(c.id), part: `n:${c.id}`, terms: ctx.terms || [] }))
    }
  }
  return { rows, cites: claim ? evidenceOf(claim).length : 0, shown: null, cut: false, fixes, windowed: false }
}

/** A narrow pane's list of clusters, one per line: `● name N`, the one chosen bold in its color. */
function clusterLines(groups, W, { group, chosen }) {
  return groups.map(g => {
    const on = chosen && g.key === group
    const t = toneOf(g.i)
    const name = cutWords(g.name, Math.max(6, W - 4 - String(g.n).length))
    return on
      ? [{ s: ' ' }, { s: `● ${name}`, tone: t, bold: true, part: `g:${g.key}` }, { s: ` ${g.n}`, tone: 'dim', part: `g:${g.key}` }]
      : [{ s: ' ' }, { s: '●', tone: t, part: `g:${g.key}` }, { s: ` ${name}`, part: `g:${g.key}` }, { s: ` ${g.n}`, tone: 'dim', part: `g:${g.key}` }]
  })
}

/** Rows a pane narrower than this lists its clusters one per line instead of the map. */
export const NARROW = 48
/** A session with fewer claims than this has no map: a few dots in one or two cells look sparse, so the pane lists its
 *  clusters, each with its claims (listOf). The map appears once there are this many. */
export const FEW = 10
/** The caption under the head: what the map shows and what a click does; and in a list of clusters. */
export const CAPTION_MAP = "Each dot is a claim from this chat, grouped by question; click a name or a dot."
export const CAPTION_LIST = "The claims of this chat, grouped by question; click a cluster or a claim."
/** The rows the keys take under the detail: a rule and the keys' row. */
const KEYS_ROWS = 2

/** The groups with their claims' count, in the order listed: [{...group, key, n}], the empty ones left out. */
function counted(data) {
  const counts = new Map()
  for (const c of data.claims || []) counts.set(claimGroup(data, c), (counts.get(claimGroup(data, c)) || 0) + 1)
  return (data.groups || []).map(g => ({ ...g, key: groupKey(g), n: counts.get(groupKey(g)) || 0 })).filter(g => g.n)
}

/**
 * The Claims pane as rows of runs, w × h cells (the rows the pane has, the keys' rule and row included): the head, the
 * map (every cluster, at most as many as it draws at this size: fitClusters; a list of clusters in a narrow pane), then
 * the detail under it (panelOf), when a cluster or a claim is chosen. With fewer than FEW claims there is no map: the
 * panel lists every cluster with its claims (listOf), and `listed` is true. The map's cells are seven rows tall, and shorter,
 * down to four, while the detail does not fit under them; past that the rows run on and the pane scrolls. `st` =
 * {claim, group, at, open, cite, all, whole, from}: the claim picked, else the cluster chosen (its key), the last turn
 * when it was chosen; with a claim, whether its evidence is open, the citation shown, the whole history, the whole
 * evidence; `from` the first claim of the list's window, once the person paged. `bright`: claims came in a moment ago.
 * Returns {head, graph, panel, claim, group, chosen, cites, shown, cut, fixes, windowed, narrow, cellRows, listed, data,
 * order}; `data` the data as fitted; `order` the clusters' keys in reading order as drawn (the map's cells row by row,
 * left to right; a list top to bottom), the order p n walk. head, graph and panel are rows of runs, a run's `part` what
 * a press on it does (`g:<key>` a cluster, `d:<id>` a dot, `n:<id>` a claim of the cluster, `ev-N` a citation,
 * `cite-prev` `cite-next` the citation before or after, `was-<id>` another version of the claim, `pg:<i>` a screen of
 * the list from its claim i).
 */
export function graphView(raw, st = {}, { w = 90, h = 40, bright = false, terms = [], passage = null, explainer = null } = {}) {
  const ctx = { terms, passage, explainer }
  const W = Math.max(24, w)
  const narrow = W < NARROW
  const H = Math.max(12, h)
  // too few claims for a map: the clusters as a list, each with its claims, none joined
  const few = (raw.claims || []).length < FEW
  const data = few ? raw : fitClusters(raw, mapCapacity(W, H))
  const claims = data.claims || []
  const byId = new Map(claims.map(c => [c.id, c]))
  const groups = data.groups || []
  const gi = new Map(groups.map(g => [String(g.id), g.i]))
  const tone = c => toneOf(gi.get(String(c.cluster)) ?? 0)
  const { claim, group, chosen } = selectedOf(data, st)
  const fresh = freshOf(data, st)
  // `+N new` for a moment: the claims that came in while browsing, else the last look's. The head counts the store's
  // clusters, not the cells the map joined them into
  const head = [headRuns(raw, { narrow, fresh: bright ? fresh.size || claims.filter(c => c.turn != null && c.turn === data.last).length : 0 })]
  for (const g of data.gaps || []) head.push([{ s: `Turn ${g.turn} was not read: `, tone: 'bad' }, { s: cut(g.why || 'the look at the answer failed', W - 24), tone: 'dim' }])
  const none = { claim: null, group: null, chosen: false, cites: 0, shown: null, cut: false, fixes: 0, windowed: false, narrow, cellRows: 0, data, order: [] }
  if (!claims.length) return { head, graph: [], panel: [], ...none }
  // at rest, a caption under the head: what the pane shows and what a click does
  if (!selectedOf(data, st).chosen) head.push(...wrap(few || narrow ? CAPTION_LIST : CAPTION_MAP, W).map(l => [{ s: l, tone: 'dim' }]))
  const mapped = counted(data)
  const listed = mapped.map(g => g.key)
  if (few) return { head, graph: [], ...result(listOf({ data, claim, group, chosen, tone, W, byId, st, fresh, narrow, ctx })), claim, group, chosen, narrow, cellRows: 0, listed: true, data, order: listed }
  const top = head.length + 1
  const detail = room => (chosen ? panelOf({ data, claim, group, tone, W, byId, room, st, fresh, narrow, ctx }) : null)
  if (narrow) {
    const list = clusterLines(mapped, W, { group, chosen })
    const panel = detail(H - top - list.length - KEYS_ROWS)
    return { head, graph: list, ...result(panel), claim, group, chosen, narrow, cellRows: 0, data, order: listed }
  }
  const cols = mapColumns(W)
  const cellRowsOf = Math.ceil(mapped.length / Math.min(cols, mapped.length))
  // the cells shorten, seven rows to four, while the map or the detail does not fit: an evidence taller than the room,
  // or a list with too few rows left for a few claims
  let ch = CELL_ROWS
  let panel = detail(H - top - ch * cellRowsOf - KEYS_ROWS)
  const tight = (p, room) => room < 0 || (!!p && (p.rows.length > room || (p.windowed && room < 12)))
  while (ch > CELL_MIN && tight(panel, H - top - ch * cellRowsOf - KEYS_ROWS)) {
    ch--
    panel = detail(H - top - ch * cellRowsOf - KEYS_ROWS)
  }
  // a detail still taller than its room under the shortest cells keeps to it, so the pane never scrolls: the rows that
  // do not fit go from the middle, the steps between citations stay; c (all code and output) and h (the whole
  // history) show it all
  const room = H - top - ch * cellRowsOf - KEYS_ROWS
  if (panel && panel.rows.length > room && !st.whole && !st.all) panel = clipped(panel, Math.max(3, room), !!st.open)
  const graph = graphOf({ data, claims, groups: mapped, edges: data.edges || [], W, h: ch * cellRowsOf, cols, group, tone, chosen, fresh }).rows()
  // the clusters as the map draws them, row by row and left to right: the order p n walk
  const drawn = layOf(claims, mapped, data.edges || [], W, ch * cellRowsOf, cols).names.slice().sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x)
  return { head, graph, ...result(panel), claim, group, chosen, narrow, cellRows: ch, data, order: drawn.map(nm => (nm.id === '' ? '-' : nm.id)) }
}

/** A detail cut to `room` rows: its head and, with the evidence open, its last two rows (the steps between citations)
 *  kept, and `… N more rows` dim where rows went. Cut, so c offers the whole. */
function clipped(panel, room, open) {
  const tail = open ? panel.rows.slice(-2) : []
  const keep = Math.max(1, room - tail.length - 1)
  const gone = panel.rows.length - keep - tail.length
  return { ...panel, rows: [...panel.rows.slice(0, keep), [{ s: `  … ${gone} more row${gone === 1 ? '' : 's'}`, tone: 'dim' }], ...tail], cut: true }
}

/** What the detail gives the view. */
const result = panel => ({
  panel: panel ? panel.rows : [], cites: panel?.cites ?? 0, shown: panel?.shown ?? null, cut: !!panel?.cut, fixes: panel?.fixes ?? 0, windowed: !!panel?.windowed,
})

/** The head: Claims, how many and in how many clusters (`no claims yet` before the first), and `+N new` for a moment
 *  after claims came in. The clusters are the lens's that hold claims (the claims between clusters are none). */
function headRuns(data, { narrow = false, fresh = 0 } = {}) {
  const n = data.total || 0
  const groups = (data.groups || []).filter(g => g.id != null).length
  const out = [{ s: 'Claims', bold: true }]
  if (!n) out.push({ s: ' · no claims yet', tone: 'dim' })
  else out.push({ s: ` · ${n.toLocaleString('en-US')}${narrow ? '' : ` claim${n === 1 ? '' : 's'}`}${groups > 1 ? ` · ${groups} clusters` : ''}`, tone: 'dim' })
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
