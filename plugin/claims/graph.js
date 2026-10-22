// graph.js: the Claims pane as pure functions over the conversation's claims (store.js): the graph laid out in cells,
// the panel under it (the claim selected and its cluster), and where a claim was said. No `$`, no DOM: pane.tsx draws what this
// returns with Claude Code's own elements, and the tests read it as text.
//
//   the head        how many claims the conversation holds, and in how many clusters
//   the graph       the whole pane wide: each cluster a loose group of dots in its own color, its name in the same
//                   color under them, wrapped so a long name shows in full; the clusters spread over the pane; a hollow
//                   dot is a claim a later one corrected, a heavier one a claim said twice or more. No lines join the
//                   dots. The dots keep their places while the person walks them
//   the selection   a press on a cluster's name, or n p, selects the cluster: its dots and name bold, every other dot
//                   and name dim. A press on a dot, or on a claim in the panel, selects that claim: its dot bold, its
//                   cluster's other dots lit, the rest dim
//   the panel       under the graph: the cluster's name bold in its color and how many claims it holds, then its
//                   claims, each after a dim – and wrapped under its first word, each a press that selects it. A claim
//                   selected keeps the list: it is ▸ and bold in the cluster's color, the others dim, and under it one
//                   line of chips (its citations' checks, `corrected`, its turn). e opens its evidence there: for a
//                   corrected claim its history (what it said before and why it changed), then its citations one at a
//                   time as the citation's card in the reply draws them (the cited words and the check, the code line
//                   that printed the value and the output line, or the file's place and the line, the cited words
//                   tinted), where it was said and which citation of how many; a press on a citation opens its evidence
//   where it was said   the message that said the claim, its words marked, and the other places it was said
//
// A canvas (canvas()) is a grid of cells: text and dots that are parts (a press on the part; the blank cells beside a
// dot or a name are part of it). canvas.rows() gives each row as runs of {s, tone, bold, part}.
import { blocks } from '../marks/message.js'
import { evidenceLine, firstSentence, hiddenOutput, lineWindow, moreLines, printLine } from '../tray/tray.mjs'
import { edgesOf, findQuote, plainOf, viewOf } from './store.js'

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

/** A cluster's color: the six categorical tones in turn. */
export const toneOf = i => `c${(Math.max(0, i) % 6) + 1}`
/** A claim's dot: hollow once corrected, heavier when said twice or more. */
export const dotOf = c => (c.revised_by ? '○' : (c.n || 1) >= 2 ? '◉' : '●')

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
 * The graph laid out in cells, w × h, the whole area used: each cluster a cell of it (cellsOf), its name wrapped at the
 * foot of the cell, a little off center by its hash, and its claims a loose ring above the name, linked claims next to
 * each other. Each claim is snapped to a cell so no two dots crowd and no dot touches a name: first inside its
 * cluster's cell, else anywhere. Deterministic. {pos: Map(id -> {x, y}), names: [{id, name, lines, x, y}], h}
 */
export function spread(nodes, clusters, edges, { w, h }) {
  const W = Math.max(20, w)
  const H = Math.max(3, h)
  const known = new Set(clusters.map(c => String(c.id)))
  const groups = clusters.map(c => ({ id: String(c.id), name: String(c.name), nodes: nodes.filter(n => String(n.cluster) === String(c.id)) })).filter(g => g.nodes.length)
  const loose = nodes.filter(n => !known.has(String(n.cluster)))
  if (loose.length) groups.push({ id: '', name: 'between clusters', nodes: loose })
  const cells = cellsOf(groups, W, H)
  // the names first, at the foot of their cells, so no dot lands on one: each wrapped to its cell's width, so a long
  // name shows in full (a cell too short for all its lines ends the last one in …)
  const names = cells.map(sl => {
    const room = Math.max(4, sl.w - 2)
    const most = Math.max(1, sl.h - 1)
    let lines = wrap(sl.g.name, room)
    if (lines.length > most) lines = [...lines.slice(0, most - 1), cut(lines.slice(most - 1).join(' '), room)]
    const l = Math.max(1, ...lines.map(len))
    const jx = (hash(sl.g.id + 'x') - 0.5) * Math.max(0, sl.w - l - 2) * 0.3
    const x = Math.max(sl.x + 1, Math.min(sl.x + sl.w - l - 1, Math.round(sl.x + (sl.w - l) / 2 + jx)))
    // a blank row under it, before the next row of clusters, where the cell has room
    const gap = sl.y + sl.h < H && sl.h >= lines.length + 3 ? 1 : 0
    const y = Math.max(0, Math.min(H - lines.length, sl.y + sl.h - lines.length - gap))
    return { id: sl.g.id, name: sl.g.name, lines, x, y, len: l }
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
      const got = near(x0, y0, box, 5) || near(x0, y0, box, 3) || near(x0, y0, all, 3) || { x: Math.max(0, Math.min(W - 2, x0)), y: Math.max(0, Math.min(H - 1, y0)) }
      taken.push(got)
      pos.set(nd.id, got)
    })
  })
  return { pos, names: names.map(({ id, name, lines, x, y }) => ({ id, name, lines, x, y })), h: H }
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

/** A claim's evidence: its sources (the store keeps at most eight). */
export const evidenceOf = c => c.sources || []

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

// a citation's check as the citation's card says it beside `cite` (tray/tray.ts STATUS): the sign and word, its tone; and
// as a chip under a claim counts it
const STATUS = {
  verified: ['✓ verified', 'good'], corrected: ['✓ verified', 'good'], failed: ['× wrong', 'bad'], unconfirmed: ['? not confirmed', 'warn'],
  checking: ['checking', 'dim'], unchecked: ['not checked', 'dim'], gone: ['no longer in the session', 'dim'],
}
const CHIP = [['good', '✓', 'verified'], ['bad', '×', 'wrong'], ['warn', '?', 'not confirmed'], ['checking', '…', 'checking'], ['dim', '·', 'not checked']]
const statusKey = s => (s.status === 'failed' && s.failedBy === 'evidence' ? 'unconfirmed' : STATUS[s.status] ? s.status : 'unchecked')

/** A line with spans of it tinted (the cited words), as runs. */
export function tinted(text, spans = []) {
  const out = []
  let at = 0
  for (const [a, b] of spans.filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    if (a < at) continue
    if (a > at) out.push({ s: text.slice(at, a) })
    out.push({ s: text.slice(a, b), tint: true })
    at = b
  }
  if (at < text.length) out.push({ s: text.slice(at) })
  return out.length ? out : [{ s: ' ' }]
}

/**
 * A citation's evidence as its card in the reply draws it (tray/tray.ts citationBody), in `room` characters: for a
 * value code computed, the one line of the code that printed it and the output line that holds it, with how many output
 * lines it leaves out; for a file, its place and the cited line. The cited words' spans in the line. Null without
 * evidence. {code?, place?, text, spans, more}
 */
export function snippetOf(ev, room) {
  const line = evidenceLine(ev)
  if (!line) return null
  const fit = lineWindow(line, Math.max(9, room))
  if (ev.kind === 'computed') return { code: printLine(ev.code, line.text), text: fit.text, spans: fit.spans, more: hiddenOutput(ev) }
  return { place: `${ev.file}:${line.n ?? ev.line}`, text: fit.text, spans: fit.spans, more: 0 }
}

/**
 * A citation as its card in the reply draws it, as rows of runs W wide: the cited words bold in the citation color and
 * its check beside them (`✓ verified · cite`); what it was, when the check corrected it, or why it is wrong, dim; then
 * its evidence (snippetOf): the code line in the code's color or the file's place dim, then the line after a dim │, the
 * cited words tinted, and `+ N more lines` when the output has more.
 */
export function citationRows(s, W) {
  const key = statusKey(s)
  const [word, tone] = STATUS[key]
  const right = [{ s: '  ' }, { s: word, tone }, { s: ' · cite', tone: 'dim' }]
  const words = one(s.shown || s.label)
  const rows = [[{ s: cut(words, Math.max(8, W - 2 - len(word) - 7)), tone: 'cite', bold: true }, ...right]]
  const dim = t => wrap(t, W).forEach(l => rows.push([{ s: l, tone: 'dim' }]))
  if (s.status === 'corrected' && s.was) dim(`was ${one(s.was)}`)
  else if (s.status === 'failed' && s.reason) dim(firstSentence(s.reason))
  const sn = s.status === 'checking' || s.status === 'gone' ? null : snippetOf(s.evidence, W - 2)
  if (!sn) return rows
  if (sn.code) rows.push([{ s: cut(sn.code, W), tone: 'code' }])
  if (sn.place) rows.push([{ s: cut(sn.place, W), tone: 'dim' }])
  const line = [{ s: '│', tone: 'dim-faint' }, { s: ' ' }, ...tinted(sn.text, sn.spans)]
  const more = sn.more ? moreLines(sn.more) : ''
  if (more && 2 + len(sn.text) + 2 + len(more) <= W) rows.push([...line, { s: `  ${more}`, tone: 'dim' }])
  else {
    rows.push(line)
    if (more) rows.push([{ s: '│', tone: 'dim-faint' }, { s: ' ' }, { s: more, tone: 'dim' }])
  }
  return rows
}

/** What a claim's citations' checks found, as chips: `✓ 3 citations verified`, then `× 1 wrong`, `? 1 not confirmed`,
 *  `… 1 checking`, `· 1 not checked`, each in its tone; `cites nothing` without citations. Runs, two spaces between. */
export function checkChips(c) {
  const srcs = c.sources || []
  if (!srcs.length) return [{ s: 'cites nothing', tone: 'dim' }]
  const count = { good: 0, bad: 0, warn: 0, checking: 0, dim: 0 }
  for (const s of srcs) {
    const k = statusKey(s)
    count[k === 'checking' ? 'checking' : STATUS[k][1]]++
  }
  const out = []
  for (const [k, sign, word] of CHIP) {
    const n = count[k]
    if (!n) continue
    if (out.length) out.push({ s: '  ' })
    out.push({ s: `${sign} ${n}${out.length ? '' : ` citation${n === 1 ? '' : 's'}`} ${word}`, tone: k === 'checking' ? 'dim' : k })
  }
  return out
}

// why a claim was wrong, as a check of its citations said it: the reason of one it failed or corrected
const checkWhy = c => (c?.sources || []).map(s => ((s.status === 'failed' || s.status === 'corrected') && s.reason ? s.reason : '')).find(Boolean) || ''

/**
 * A claim's history, each {when, text, why, later, part}: a claim that corrects an earlier one, what that one said, in
 * its turn, and why it changed (the claims look's reason, kept with the claim, else the reason of the check that failed
 * the earlier one's citation); a claim whose citation the check corrected, what the citation said before the check and
 * the check's reason; a claim a later one corrected, what the later one says and why (`later`). `part`: a press selects
 * the other claim.
 */
export function correctionsOf(claim, byId) {
  const out = []
  const turn = c => (c.turn != null ? `turn ${c.turn}` : 'before')
  const old = claim.revises ? byId.get(claim.revises) : null
  if (old) out.push({ when: turn(old), text: sentenceOf(old.text), why: claim.why || checkWhy(old), later: false, part: `was-${old.id}` })
  const fixed = !old && (claim.sources || []).find(s => s.status === 'corrected' && s.was)
  if (fixed) out.push({ when: 'before the check', text: one(fixed.was), why: fixed.reason || '', later: false, part: null })
  const later = claim.revised_by ? byId.get(claim.revised_by) : null
  if (later) out.push({ when: later.turn != null ? `later, turn ${later.turn}` : 'later', text: sentenceOf(later.text), why: later.why || checkWhy(claim), later: true, part: `was-${later.id}` })
  return out.map(x => ({ ...x, why: x.why ? sentenceOf(x.why) : '' }))
}

/** One graph of clusters on a canvas: their claims as dots in the cluster's color and their names under them in the
 *  same color, no lines. With a selection (`chosen`), the cluster selected stays lit and every other dot and name dims;
 *  its dots and name are bold while the cluster itself is selected, else only the claim selected is. A name is a press on its cluster (`g:<key>`),
 *  a dot a press on its claim (`d:<id>`). */
function graphOf({ data, claims, groups, edges, W, h, claim, group, tone, chosen }) {
  const lay = layOf(claims, groups, edges, W, h)
  const c = canvas(W, lay.h)
  const keyOf = id => (id === '' ? '-' : id)
  const toneOfGroup = k => toneOf((groups.find(g => groupKey(g) === k) || { i: 0 }).i)
  for (const nm of lay.names) {
    const k = keyOf(nm.id)
    const on = !chosen || k === group
    const t = toneOfGroup(k)
    nm.lines.forEach((l, i) => c.text(nm.x, nm.y + i, [{ s: l, tone: on ? t : `${t}-faint`, bold: chosen && on, part: `g:${k}` }]))
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

/** A cluster's name as rows W wide: its dot and the name wrapped, bold in the cluster's color, and after it, on its
 *  last row when they fit, else on a row of their own, the dim words `after`. Every run a press on `part`. */
function nameRows(name, tone, W, { after = '', part = null } = {}) {
  const lines = wrap(name, W - 2)
  const rows = lines.map((l, i) => [{ s: i ? '  ' : '● ', tone, part }, { s: l, tone, bold: true, part }])
  if (after) {
    const last = rows[rows.length - 1]
    if (2 + len(lines[lines.length - 1]) + 1 + len(after) <= W) last.push({ s: ` ${after}`, tone: 'dim', part })
    else rows.push([{ s: '  ', part }, { s: after, tone: 'dim', part }])
  }
  return rows
}

/** A claim in the cluster's list, as rows W wide, each a press on `part`: a dim `–` and its sentence, wrapped under its
 *  first word, so a claim of two lines reads as one. The claim selected: `▸` and the sentence bold in the cluster's
 *  color; with a claim selected, every other one dim. */
function itemRows(c, W, { tone, picked = false, dim = false, part = null }) {
  const look = picked ? { tone, bold: true } : dim ? { tone: 'dim' } : {}
  return wrap(sentenceOf(c.text), W - 4).map((l, i) => (i
    ? [{ s: '    ', part }, { s: l, ...look, part }]
    : [{ s: '  ', part }, { s: picked ? '▸ ' : '– ', ...(picked ? look : { tone: 'dim' }), part }, { s: l, ...look, part }]))
}

/** Rows indented by n cells. */
const indent = (rows, n) => rows.map(r => (r.length ? [{ s: ' '.repeat(n), part: r[0].part ?? null }, ...r] : r))

/** Where a claim was said, for the line under a citation: the place in the citation's message, else the first. */
function saidOf(claim, s) {
  const said = claim.said || []
  return said.find(x => x.row && x.row === s?.row) || said[0] || null
}

/**
 * A claim's evidence, opened under it with e, as rows W wide: for a corrected claim first its History (what it said in
 * the earlier turn, and why it changed; a press selects the other claim), then one citation as its card draws it
 * (citationRows; a press opens its evidence, `ev-N`), then, dim, where it was said (a press opens the message, `src`)
 * and which citation of how many it is. `cite` the citation shown, from 0.
 */
export function evidenceRows(claim, byId, W, cite = 0) {
  const rows = []
  const fixes = correctionsOf(claim, byId)
  if (fixes.length) {
    rows.push([], [{ s: 'History', bold: true }])
    for (const x of fixes) {
      const lead = len(x.when) + 2
      wrap(`"${x.text}"`, Math.max(12, W - lead)).forEach((l, i) => rows.push([{ s: i ? ' '.repeat(lead) : `${x.when}  `, tone: i ? null : 'dim', part: x.part }, { s: l, part: x.part }]))
      if (x.why) wrap(`why it changed: ${x.why}`, W).forEach((l, i) => rows.push(i ? [{ s: l }] : [{ s: 'why it changed:', tone: 'dim' }, { s: l.slice('why it changed:'.length) }]))
    }
  }
  const evidence = evidenceOf(claim)
  rows.push([])
  const i = Math.max(0, Math.min(evidence.length - 1, Number(cite) || 0))
  const s = evidence[i] || null
  if (!s) rows.push([{ s: 'It cites nothing.', tone: 'dim' }])
  else {
    const part = s.row && s.n ? `ev-${i + 1}` : null
    for (const r of citationRows(s, W)) rows.push(r.map(x => ({ ...x, part })))
  }
  const at = saidOf(claim, s)
  if (at && (at.quote || at.sentence)) {
    const who = at.by === 'person' ? 'you said' : 'said'
    const lead = `${who}${at.turn != null ? ` in turn ${at.turn}` : ''}: `
    rows.push([{ s: lead + `"${cut(one(at.quote || at.sentence), Math.max(8, W - len(lead) - 2))}"`, tone: 'dim', part: 'src' }])
  }
  if (evidence.length > 1) rows.push([{ s: `citation ${i + 1} of ${evidence.length}`, tone: 'dim' }])
  return rows
}

/**
 * The panel under the graph, as rows of runs W wide, after a rule: the cluster's name (`● name · N claims`, the name
 * bold in its color; a press selects the cluster, `g:<key>`) and its claims (itemRows; a press selects one, `n:<id>`).
 * With a claim selected the list stays: the claim `▸` and bold in the cluster's color, the others dim, and under it one
 * line of chips (checkChips, `corrected` when it was, its turn); with `open` its evidence under that (evidenceRows).
 * The list keeps to `room` rows: past that, a window round the claim selected, with how many claims it leaves out.
 * {rows, cites}: cites how many citations the claim selected has.
 */
export function panelOf({ data, claim, group, tone, W, byId = new Map((data.claims || []).map(c => [c.id, c])), room = 16, open = false, cite = 0 }) {
  const { name, cs } = groupOf(data, group)
  const gtone = tone(cs[0] || claim || {})
  const rows = [[{ s: '─'.repeat(W), tone: 'dim-faint' }], ...nameRows(name, gtone, W, { after: clusterWords(cs), part: `g:${group}` })]
  const items = cs.map(c => itemRows(c, W, { tone: gtone, picked: claim?.id === c.id, dim: !!claim && claim.id !== c.id, part: claim?.id === c.id ? `g:${group}` : `n:${c.id}` }))
  // the window of claims the list shows: all when they fit, else from the claim selected (or the first) outward
  const budget = Math.max(4, room - rows.length - 1)
  const at = Math.max(0, claim ? cs.findIndex(c => c.id === claim.id) : 0)
  let lo = at, hi = at + 1, used = items[at]?.length || 0
  for (let grew = true; grew;) {
    grew = false
    if (hi < items.length && used + items[hi].length <= budget) { used += items[hi].length; hi++; grew = true }
    if (claim && lo > 0 && used + items[lo - 1].length <= budget) { lo--; used += items[lo].length; grew = true }
  }
  if (lo > 0) rows.push([{ s: `  + ${lo} earlier`, tone: 'dim' }])
  for (let i = lo; i < hi; i++) {
    rows.push(...items[i])
    if (claim && cs[i].id === claim.id) {
      const fixes = correctionsOf(claim, byId)
      const chips = [...checkChips(claim)]
      if (fixes.length) chips.push({ s: '  ' }, { s: fixes.some(x => !x.later) ? 'corrected' : 'corrected later', tone: 'cite' })
      const when = whenOf(claim)
      if (when) chips.push({ s: '  ' }, { s: when, tone: 'dim' })
      rows.push(fit([{ s: '    ' }, ...chips], W))
      if (open) rows.push(...indent(evidenceRows(claim, byId, W - 4, cite), 4))
    }
  }
  if (hi < items.length) rows.push([{ s: `  + ${items.length - hi} more: a dot selects one`, tone: 'dim' }])
  return { rows, cites: claim ? evidenceOf(claim).length : 0 }
}

/**
 * The Claims pane as rows of runs, w × h cells (the rows the pane has; the keys' row under it takes two): the head,
 * then the graph, then the panel under it (panelOf). `st` = {claim, group, at, open, cite}: the claim selected, else
 * the cluster selected (its key), the last turn when it was selected; with a claim, whether its evidence is open and
 * the citation shown. Returns {head, graph, panel, claim, group, history, chosen, cites}; head, graph and panel are
 * rows of runs, a run's `part` what a press on it does (`g:<key>` a cluster, `d:<id>` a dot, `n:<id>` a claim of the
 * cluster in the panel, `ev-N` a citation, `was-<id>` another version of the claim, `src` where it was said).
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
    return { head, graph: [], panel: [], claim: null, group: null, history: [], chosen: false, cites: 0 }
  }
  const { claim, group, fresh } = selectedOf(data, st)
  const history = claim ? historyOf(claim, byId) : []
  const H = Math.max(10, h - 2)
  // the graph keeps the same rows whatever is selected, so its dots keep their places: PANEL rows are kept for the panel
  // under it (at least 8 rows stay the graph's), and the cluster's claims fit in what the panel's other rows leave
  const all = Math.max(6, H - head.length - 1)
  const room = Math.max(Math.min(8, all), all - PANEL)
  const { rows: panel, cites } = panelOf({ data, claim, group, tone, W, byId, room: all - room, open: !!(claim && st.open), cite: st.cite })
  const chosen = !fresh && (!!claim || (st.group != null && String(st.group) === group))
  const graph = graphOf({ data, claims, groups, edges: data.edges || [], W, h: room, claim, group, tone, chosen }).rows()
  return { head, graph, panel, claim, group, history, chosen, cites }
}

/** The head: Claims, how many and in how many clusters. */
function headRuns(data) {
  const n = data.total || 0
  const groups = (data.groups || []).length
  const out = [{ s: 'Claims', tone: 'c2', bold: true }]
  if (n) out.push({ s: ` · ${n.toLocaleString('en-US')} claim${n === 1 ? '' : 's'}${groups > 1 ? ` · ${groups} clusters` : ''}`, tone: 'dim' })
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
