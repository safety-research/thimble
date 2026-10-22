// graph.js: the Claims pane as pure functions over the conversation's claims (store.js): the graph laid out in cells,
// the panel under it (the claim selected and its cluster), and where a claim was said. No `$`, no DOM: pane.tsx draws what this
// returns with Claude Code's own elements, and the tests read it as text.
//
//   the head        how many claims the conversation holds, and in how many clusters
//   the graph       the whole pane wide: each cluster a loose group of dots in its own color, its name in plain gray
//                   among them, the clusters spread over the pane; a hollow dot is a claim a later one corrected, a
//                   heavier one a claim said twice or more. No lines join the dots. The dots keep their places while the
//                   person walks them
//   the selection   a cluster first, then one of its claims (details on demand): a press on a cluster's name, on a dot
//                   of another cluster, or n p, selects the cluster: its dots bold, every other dot and name dim. A press
//                   on a dot of the cluster selected, or on a claim in the panel, selects that claim: its dot bold, its
//                   cluster's other dots lit, the rest dim
//   the panel       under the graph. A cluster: its name, what it holds in one line, and its claims, each a press that
//                   selects it. A claim: its cluster's name (a press selects the cluster) and its whole sentence; e adds
//                   its citations (each with its check, its words and the cited line; a press opens its evidence), h
//                   its history
//   where it was said   the message that said the claim, its words marked, and the other places it was said
//
// A canvas (canvas()) is a grid of cells: text and dots that are parts (a press on the part; the blank cells beside a
// dot or a name are part of it). canvas.rows() gives each row as runs of {s, tone, bold, part}.
import { blocks } from '../marks/message.js'
import { edgesOf, findQuote, plainOf, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const len = s => Array.from(String(s ?? '')).length
/** A claim's words as a sentence: with its full stop. */
export const sentenceOf = s => one(s).replace(/([\p{L}\p{N}%)"'”’])$/u, '$1.')
const MAX_EVIDENCE = 4
/** The rows the panel under the graph keeps: a cluster and about fifteen of its claims, or a claim and its citations. */
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

/** A cluster's color: the six categorical tones in turn. */
export const toneOf = i => `c${(Math.max(0, i) % 6) + 1}`
/** A claim's dot: hollow once corrected, heavier when said twice or more. */
export const dotOf = c => (c.revised_by ? '○' : (c.n || 1) >= 2 ? '◉' : '●')

/** Who said a claim and when, in a few words, for a side thread: `turn 2`, `turn 2 · you`. */
export function whenOf(c) {
  return [c.turn != null ? `turn ${c.turn}` : '', c.by === 'person' ? 'you' : ''].filter(Boolean).join(' · ')
}

/** Who said a claim and how often, as the pane says it after the sentence: `you said this`, `said 3 times`. */
export function saidWords(c) {
  const n = c.n || 1
  if (c.by === 'person') return n >= 2 ? `you said this ${n} times` : 'you said this'
  return n >= 2 ? `said ${n} times` : ''
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
  ...(c.links && c.links.length ? { links: c.links.map(l => ({ to: l.to, how: l.how })) } : {}),
  sources: (c.sources || []).slice(0, 8),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row ?? null, by: s.by, turn: s.turn ?? null, quote: s.quote || '', sentence: s.sentence || '', ...(s.start != null ? { start: s.start, end: s.end } : {}), ...(s.ref ? { ref: s.ref } : {}) })),
})

/** The store as the pane reads it: its claims in the order listed (cluster by cluster), the groups with their colors'
 *  order, the edges, and the head's facts. */
export function paneData(store) {
  const view = viewOf({ clusters: [], gaps: [], ...(store || {}), claims: Array.isArray(store?.claims) ? store.claims : [] })
  const claims = view.flat.map(slim)
  const groups = view.groups.map((g, i) => ({ id: g.id ?? null, name: g.name, i }))
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

/** What the pane shows: the claim the state names, else the cluster it names; else, at rest, the cluster of the newest
 *  correction of the last turn, else of the newest claim. After a turn that came since the selection, the pane opens on
 *  what is new. {claim, group, fresh}: claim null while a cluster is selected; group the key of the cluster shown. */
export function selectedOf(data, st = {}) {
  const claims = data.claims || []
  if (!claims.length) return { claim: null, group: null, fresh: false }
  const byId = new Map(claims.map(c => [c.id, c]))
  const fresh = st.at != null && data.last != null && st.at < data.last
  const picked = !fresh && st.claim ? byId.get(st.claim) : null
  if (picked) return { claim: picked, group: claimGroup(data, picked), fresh }
  if (!fresh && st.group != null && (data.groups || []).some(g => groupKey(g) === String(st.group))) return { claim: null, group: String(st.group), fresh }
  const newest = claims.reduce((b, c) => ((c.turn ?? -1) > (b.turn ?? -1) || ((c.turn ?? -1) === (b.turn ?? -1) && num(c) > num(b)) ? c : b))
  const fixes = claims.filter(c => c.revises && c.turn != null && c.turn === newest.turn)
  const rest = fixes.length ? fixes.reduce((b, c) => (num(c) > num(b) ? c : b)) : newest
  return { claim: null, group: claimGroup(data, rest), fresh }
}

/** The key of the cluster after or before the one given (n p), in the order the clusters are listed. */
export function hopCluster(data, key, dir) {
  const order = (data.groups || []).map(groupKey)
  if (!order.length) return null
  const at = order.indexOf(String(key))
  return order[at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length]
}

/** A claim's evidence: its sources, at most MAX_EVIDENCE. */
export const evidenceOf = c => (c.sources || []).slice(0, MAX_EVIDENCE)

/** What the side thread about the pane is about: the claim selected, the cluster selected, or the place a claim was
 *  said. Text a model reads. */
export function threadAbout(c, source = false, cluster = null) {
  if (!c && cluster) return `the claims of this session as a graph, in clusters; the cluster selected is "${cut(cluster.name, 120)}" (${cluster.n} claim${cluster.n === 1 ? '' : 's'})`
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

/** The words of a source in the panel, as runs: a citation's check, its words, the cited place, and with `full` (e) the
 *  cited line. */
export function evidenceRuns(s, full = true) {
  // the check's words, as the evidence pane says them (marks/evidence.tsx)
  const status = s.status || 'unchecked'
  const unconfirmed = status === 'failed' && s.failedBy === 'evidence'
  const tone = status === 'verified' ? 'good' : status === 'corrected' || unconfirmed ? 'warn' : status === 'failed' ? 'bad' : 'dim'
  const word = unconfirmed ? 'not confirmed' : ({ failed: 'wrong', unchecked: 'not checked', gone: 'no longer in the session' })[status] || status
  const out = [{ s: word, tone, bold: true }, { s: ' ' }, { s: one(s.shown || s.label), tone: 'cite' }]
  if (s.place) out.push({ s: `  ${s.place}`, tone: 'dim' })
  if (full && s.line) out.push({ s: `  ${one(s.line)}` })
  return out
}

/** The history as rows in the panel: each version, oldest first, with where it was said; the one selected bold,
 *  each other a press that selects it. [{runs, part}] */
function historyRows(history, claim, tone) {
  const out = []
  for (const c of history) {
    const said = (c.said || []).find(x => x.sentence || x.quote)
    const who = c.by === 'person' ? 'you said' : 'Claude said'
    const part = c.id === claim.id ? null : `was-${c.id}`
    out.push({ runs: [{ s: dotOf(c), tone: tone(c) }, { s: ' ' }, { s: sentenceOf(c.text), bold: c.id === claim.id }], part })
    out.push({ runs: said ? [{ s: '  ' }, { s: who, tone: 'dim' }, { s: ` “${one(said.sentence || said.quote)}”` }] : [{ s: '  ' }, { s: who, tone: 'dim' }], part })
  }
  return out
}

/** One graph of clusters on a canvas: their names in plain gray, their claims as dots in the cluster's color, no lines.
 *  With a selection (`chosen`), the cluster selected stays lit and every other dot and name dims; its dots are bold
 *  while the cluster itself is selected, else only the claim selected is. A name is a press on its cluster (`g:<key>`),
 *  a dot a press on its claim (`d:<id>`). */
function graphOf({ data, claims, groups, edges, W, h, claim, group, tone, chosen }) {
  const lay = layOf(claims, groups, edges, W, h)
  const c = canvas(W, lay.h)
  const keyOf = id => (id === '' ? '-' : id)
  for (const nm of lay.names) {
    const on = !chosen || keyOf(nm.id) === group
    c.text(nm.x, nm.y, [{ s: nm.name, tone: on ? 'dim' : 'dim-faint', bold: chosen && on, part: `g:${keyOf(nm.id)}` }])
  }
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (!p) continue
    const mine = claimGroup(data, x) === group
    const lit = !chosen || mine
    const bold = chosen && (claim ? x.id === claim.id : mine)
    c.dot(p.x, p.y, dotOf(x), lit ? tone(x) : `${tone(x)}-faint`, { bold, part: `d:${x.id}` })
  }
  // a click lands on a blank cell beside a dot or a name too: a press of one cell alone is hard to hit
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (p) for (const dx of [-1, 1]) c.pad(p.x + dx, p.y, `d:${x.id}`)
  }
  for (const nm of lay.names) for (const x of [nm.x - 1, nm.x + len(nm.name)]) c.pad(x, nm.y, `g:${keyOf(nm.id)}`)
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

/** What a cluster holds, in one line: how many claims, how many were corrected, the turns they were said in. */
export function clusterWords(cs) {
  const n = cs.length
  const fixed = cs.filter(c => c.revised_by).length
  const turns = cs.map(c => c.turn).filter(t => typeof t === 'number')
  const lo = turns.length ? Math.min(...turns) : null, hi = turns.length ? Math.max(...turns) : null
  return [
    `${n} claim${n === 1 ? '' : 's'}`,
    fixed ? `${fixed} corrected` : '',
    lo == null ? '' : lo === hi ? `turn ${lo}` : `turns ${lo}–${hi}`,
  ].filter(Boolean).join(' · ')
}

/** A group's name and claims. {g, name, cs} */
export function groupOf(data, key) {
  const g = (data.groups || []).find(x => groupKey(x) === String(key)) ?? null
  return { g, name: g ? g.name : 'between clusters', cs: (data.claims || []).filter(c => claimGroup(data, c) === String(key)) }
}

/**
 * The panel under the graph, as rows of runs W wide, after a rule. With a cluster selected (`claim` null): its name,
 * what it holds, and its claims, one line each, each a press that selects it (`n:<id>`); at most `maxSubs` of them. With
 * a claim selected: its cluster's name (a press selects the cluster, `g:<key>`), then the claim's whole sentence; e
 * (`open` 'ev') adds its citations (a press: the citation's evidence, `ev-N`), h ('hist') its history (a press: that
 * version, `was-<id>`). `fixed` rows come before the cluster's claims. {rows, fixed}
 */
export function panelOf({ data, claim, group, open, evidence, history, tone, W, maxSubs = 8 }) {
  const { name, cs } = groupOf(data, group)
  const gtone = tone(cs[0] || claim || {})
  const top = [[{ s: '─'.repeat(W), tone: 'dim-faint' }]]
  if (!claim) {
    top.push(fit([{ s: name, tone: gtone, bold: true }, { s: `   ${clusterWords(cs)}`, tone: 'dim' }], W))
    const k = Math.max(1, maxSubs)
    const shown = cs.length <= k ? cs : cs.slice(0, k - 1)
    const subs = shown.map(c => {
      const part = `n:${c.id}`
      return fit([{ s: '  ', part }, { s: `${dotOf(c)} `, tone: tone(c), part }, { s: sentenceOf(c.text), part }], W)
    })
    if (cs.length > shown.length) subs.push([{ s: `  … ${cs.length - shown.length} more in this cluster: a dot selects one`, tone: 'dim' }])
    return { rows: [...top, ...subs], fixed: top.length }
  }
  const gpart = `g:${group}`
  top.push(fit([{ s: name, tone: gtone, bold: true, part: gpart }, { s: `   ${clusterWords(cs)}`, tone: 'dim', part: gpart }], W))
  const who = saidWords(claim)
  const words = wrap(`${sentenceOf(claim.text)}${who ? ` · ${who}` : ''}`, W - 2)
  words.forEach((l, i) => {
    // the words of who said it stay dim
    const at = who && i === words.length - 1 ? l.lastIndexOf(` · ${who}`) : -1
    const body = at >= 0 ? [{ s: l.slice(0, at), bold: true }, { s: l.slice(at), tone: 'dim' }] : [{ s: l, bold: true }]
    top.push([i ? { s: '  ' } : { s: `${dotOf(claim)} `, tone: tone(claim) }, ...body])
  })
  if (open === 'ev') {
    if (!evidence.length) top.push([{ s: '  ' }, { s: 'It cites nothing.', tone: 'dim' }])
    evidence.forEach((s, i) => {
      const part = s.row && s.n ? `ev-${i + 1}` : null
      top.push(fit([{ s: '  ', part }, ...evidenceRuns(s).map(r => ({ ...r, part }))], W))
    })
  }
  if (open === 'hist') for (const r of historyRows(history, claim, tone)) top.push(fit([{ s: '  ', part: r.part }, ...r.runs.map(x => ({ ...x, part: r.part }))], W))
  return { rows: top, fixed: top.length }
}

/**
 * The Claims pane as rows of runs, w × h cells (the rows the pane has; the keys' row under it takes two): the head,
 * then the graph, then the panel under it (panelOf). `st` = {claim, group, open, at}: the claim selected, else the
 * cluster selected (its key), what e or h opened ('ev' | 'hist'), the last turn when it was selected. Returns {head,
 * graph, panel, claim, group, history, chosen, open}; head, graph and panel are rows of runs, a run's `part` what a
 * press on it does (`g:<key>` a cluster, `d:<id>` a dot, `n:<id>` a claim of the cluster in the panel, `ev-N`,
 * `was-<id>`).
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
    return { head, graph: [], panel: [], claim: null, group: null, history: [], chosen: false, open: null }
  }
  const { claim, group, fresh } = selectedOf(data, st)
  const evidence = claim ? evidenceOf(claim) : []
  const history = claim ? historyOf(claim, byId) : []
  const open = claim && (st.open === 'ev' || (st.open === 'hist' && history.length > 1)) ? st.open : null
  const H = Math.max(10, h - 2)
  // the graph keeps the same rows whatever is selected, so its dots keep their places: PANEL rows are kept for the panel
  // under it (at least 8 rows stay the graph's), and the cluster's claims fit in what the panel's other rows leave
  const all = Math.max(6, H - head.length - 1)
  const room = Math.max(Math.min(8, all), all - PANEL)
  const panelArgs = { data, claim, group, open, evidence, history, tone, W }
  const fixed = panelOf({ ...panelArgs, maxSubs: 1 }).fixed
  const panel = panelOf({ ...panelArgs, maxSubs: Math.max(3, all - room - fixed) }).rows
  const chosen = !fresh && (!!claim || (st.group != null && String(st.group) === group))
  const graph = graphOf({ data, claims, groups, edges: data.edges || [], W, h: room, claim, group, tone, chosen }).rows()
  return { head, graph, panel, claim, group, history, chosen, open }
}

/** The head: Claims, how many and in how many clusters. */
function headRuns(data) {
  const n = data.total || 0
  const groups = (data.groups || []).length
  const out = [{ s: 'Claims', tone: 'c2', bold: true }]
  if (n) out.push({ s: `   ${n.toLocaleString('en-US')}${groups > 1 ? ` · ${groups} clusters` : ''}`, tone: 'dim' })
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
