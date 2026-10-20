// graph.js: the Claims pane, a program on the card runtime (draw/kit.js) over the session's claims (store.js). It opens
// in the side panel (claims/term.ts openSide) and is one view: the graph, and the claim selected under it.
//
//   the head        how many claims the session holds, and one action while the folder has no map yet: a press that
//                   asks Claude to add the claims of the whole folder (never a key, since it starts a turn)
//   the graph       a network: each claim a dot, the claims of a cluster together in the cluster's color under its
//                   name (each cluster a rectangle of the graph, sized by how many claims it holds), earlier claims at
//                   its left and later ones at its right, linked claims near each other; a hollow dot is a claim a later
//                   one corrected, a heavier one a claim said twice or more. A line means one thing: the two claims are
//                   related in meaning or draw on the same rows. Every line has one look: the selected claim's bright and
//                   its linked dots bold, the others faint and drawn only inside a cluster where they cross no dot, so a
//                   hundred claims stay readable. A correction is no line: the corrected claim is hollow, and its history
//                   says what corrected it. The dots keep their places while the ring walks them. The folder's map, once
//                   asked for, stands under the session's clusters, after one line that says it is the whole folder's.
//   the claim       under the graph, the claim selected: its full sentence (a press, or ↵ on its dot, opens the message
//                   that said it, its words marked, over the pane, as a citation opens)
//   actions         above the side panel's input bar, in words (e and h do the same while the input bar is empty), each
//                   opening what it names right above them: e evidence, the rows the claim cites as small tables, the
//                   values it cites marked (a press opens one as a citation); h history, only for a claim corrected or
//                   correcting another, its versions oldest first with who said each and its words (a press selects one)
//   where it was said   the same module with args {source}: the message that said the claim, its words marked, and
//                   the other places it was said
//
// What can be pressed looks like it can (a color, the ring), so the pane prints no captions, legends or turn numbers.
// The side panel holds the keys: ↑↓ walk the claims, the ring (tab) walks the claim's rows and selects what it lands on
// (k.select), and the panel's input bar asks its thread about that.
//
//   state: {claim, part: the dot or row selected, at: the last turn when it was selected, open: 'ev' | 'hist' | null}
//   reads: claims (the store with the folder's offer), threads (whether the panel's thread has a conversation, which
//          takes rows under the pane); with {source, row}: claims and the message's record
//   wants: {rows: [ref]} for each row the selected claim cites (what its rows say, through the kernel)
//   asks of the host: open {mark} (a citation, over the pane), source {id, row} (where a claim was said, over the
//   pane), folder (asks Claude to add the folder's claims)
import { chainWords } from '../shell/object.js'
import { blocks } from '../shell/message.js'
import { threadKey } from '../shell/threads.js'
import { edgesOf, findQuote, plainOf, shortRef, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
/** A claim's words as a sentence: with its full stop. */
const sentenceOf = s => one(s).replace(/([\p{L}\p{N}%)"'”’])$/u, '$1.')
const MAX_EVIDENCE = 4
const MAX_SENTENCE = 4

/** Words wrapped to lines of at most n characters (a word longer than n is cut). */
export function wrap(text, n) {
  const out = []
  let cur = ''
  for (const w of one(text).split(' ')) {
    if (!w) continue
    const word = w.length > n ? w.slice(0, n - 1) + '…' : w
    if (!cur) cur = word
    else if (cur.length + 1 + word.length <= n) cur += ' ' + word
    else { out.push(cur); cur = word }
  }
  if (cur) out.push(cur)
  return out
}

export const nodeRegion = id => `n-${String(id).replace(/[^A-Za-z0-9_.:-]/g, '-')}`
/** A cluster's color: the six categorical tones in turn. */
export const toneOf = i => `c${(Math.max(0, i) % 6) + 1}`
/** A claim's dot: hollow once corrected, heavier when said twice or more. */
export const dotOf = c => (c.revised_by ? '○' : (c.n || 1) >= 2 ? '◉' : '●')
/** A line's tone. A line means one thing, the two claims are related in meaning or draw on the same rows, so every line
 *  has one look: bright for the claim selected, faint for the rest. */
export const edgeTone = (e, bright) => (bright ? 'accent' : 'accent-faint')

/** Who said a claim and when, in a few words, for the thread's agent: `turn 2`, `turn 2 · you`, `the folder`. */
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

/**
 * Integer sizes proportional to the weights, each at least `min` where there is room, that sum to `total`.
 */
export function split(total, weights, min) {
  const n = weights.length
  const m = Math.min(min, Math.floor(total / Math.max(1, n)))
  const rest = total - m * n
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const raw = weights.map(x => m + (rest * x) / sum)
  const out = raw.map(Math.floor)
  let left = total - out.reduce((a, b) => a + b, 0)
  raw.map((v, i) => [v - Math.floor(v), i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]).forEach(([, i]) => { if (left > 0) { out[i]++; left-- } })
  return out
}

// a cluster's dots in rows, each dot `sx` cells from the one before and each row `sy` rows under the one before: the
// airiest spacing that fits the rectangle first
const SPACINGS = [[4, 2], [3, 2], [2, 2], [3, 1], [2, 1]]

/** How a cluster of n dots fits a rectangle whose dots may use iw × ih cells, at the airiest spacing from `from` on
 *  that fits: {sx, sy, per, level, fits} (per: dots in a row, the rows as even as they can be; level: the spacing's
 *  place in SPACINGS). */
export function gridOf(n, iw, ih, from = 0) {
  for (let level = from; level < SPACINGS.length; level++) {
    const [sx, sy] = SPACINGS[level]
    const most = Math.max(1, Math.floor((iw - 1) / sx) + 1)
    const rows = Math.ceil(n / most)
    if ((rows - 1) * sy + 1 <= ih) return { sx, sy, per: Math.ceil(n / rows), level, fits: true }
  }
  const [sx, sy] = SPACINGS[SPACINGS.length - 1]
  return { sx, sy, per: Math.max(1, Math.floor((iw - 1) / sx) + 1), level: SPACINGS.length - 1, fits: false }
}

/**
 * Each cluster's rectangle of the area, w × h, in rows of rectangles: the clusters in order, a row's width and the
 * rows' heights shared by how many claims each holds, and the number of rows the one where the rectangles are least
 * cramped and closest to a pleasant shape. [{g, x, y, w, h}]
 */
export function slotsOf(groups, W, H) {
  const wt = g => g.nodes.length + 1
  const total = groups.reduce((s, g) => s + wt(g), 0)
  let best = null
  for (let r = 1; r <= Math.min(groups.length, 6); r++) {
    const rows = []
    let cur = []
    let acc = 0
    groups.forEach((g, i) => {
      cur.push(g)
      acc += wt(g)
      const after = groups.length - i - 1
      const rowsAfter = r - rows.length - 1
      if (rowsAfter > 0 && (acc >= (total * (rows.length + 1)) / r || after === rowsAfter)) { rows.push(cur); cur = [] }
    })
    if (cur.length) rows.push(cur)
    if (rows.length !== r) continue
    const hs = split(H, rows.map(row => row.reduce((t, g) => t + wt(g), 0)), 3)
    const out = []
    let y = 0
    let cost = 0
    rows.forEach((row, ri) => {
      const ws = split(W, row.map(wt), Math.min(14, Math.floor(W / row.length)))
      let x = 0
      row.forEach((g, gi) => {
        const sl = { g, x, y, w: ws[gi], h: hs[ri] }
        out.push(sl)
        // the slot's top row holds the cluster's name, and its last five columns stay blank, so the gap between two
        // clusters is wider than the gap between two dots of one; its dots want the airy spacing, and must fit the dense
        // one
        const airy = gridOf(g.nodes.length, sl.w - 5, sl.h - 1)
        cost += Math.log(sl.w / Math.max(1, sl.h) / 5) ** 2 + (airy.fits ? (airy.sy === 1 ? 1 : 0) + (airy.sx < 3 ? 0.5 : 0) : 20) + (Array.from(g.name).length > sl.w - 2 ? 3 : 0)
        x += ws[gi]
      })
      y += hs[ri]
    })
    if (!best || cost < best.cost - 1e-9) best = { cost, out }
  }
  return best ? best.out : []
}

const hash = s => {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

/**
 * The graph laid out in cells, w × h, as a network: each cluster a rectangle of the area (slotsOf) with its name on the
 * top row and its claims in an island under it. Each claim starts where its turn puts it (the order `nodes` gives:
 * earlier left, later right) on a row of its own hash; the claims are pushed apart and pulled together along their
 * edges inside the island, so linked claims stand near each other; then each is snapped to a cell so no two dots touch
 * (three blank cells between two dots of one row, one between dots of rows next to each other), first inside its
 * island, else inside its rectangle, else anywhere. The last five columns of a rectangle stay blank, so two clusters
 * never touch. A cell is about twice as tall as wide, so heights count double. Deterministic.
 * {pos: Map(id -> {x, y}), names: [{id, name, x, y}], fits: every dot inside its cluster's rectangle}
 */
export function layout(nodes, clusters, edges, { w, h }) {
  const W = Math.max(20, w)
  const H = Math.max(3, h)
  const known = new Set(clusters.map(c => String(c.id)))
  const groups = clusters.map(c => ({ id: String(c.id), name: String(c.name), nodes: nodes.filter(n => String(n.cluster) === String(c.id)) })).filter(g => g.nodes.length)
  const loose = nodes.filter(n => !known.has(String(n.cluster)))
  if (loose.length) groups.push({ id: '', name: 'between clusters', nodes: loose })
  const slots = slotsOf(groups, W, H)
  const P = []
  for (const sl of slots) {
    // the rectangle a cluster's dots may use, and the island they start in: its rows, and the columns they need at its left
    const box = { x0: sl.x, x1: Math.max(sl.x, sl.x + sl.w - 6), y0: sl.y + 1, y1: Math.max(sl.y + 1, sl.y + sl.h - 1) }
    const n = sl.g.nodes.length
    const isl = { x0: box.x0, x1: Math.min(box.x1, box.x0 + 8 * Math.ceil(Math.sqrt(n)) + 2), y0: box.y0, y1: box.y1 }
    sl.g.nodes.forEach((nd, i) => {
      const tx = isl.x0 + ((isl.x1 - isl.x0) * (i + 0.5)) / n
      P.push({ id: nd.id, sl, box, ...isl, tx, x: tx, y: isl.y0 + (isl.y1 - isl.y0) * hash(nd.id + '#'), vx: 0, vy: 0 })
    })
  }
  const at = new Map(P.map((p, i) => [p.id, i]))
  const springs = (edges || []).map(e => [at.get(e.a), at.get(e.b)]).filter(([i, j]) => i != null && j != null && P[i].sl === P[j].sl)
  for (let it = 0; it < 200; it++) {
    const a = 1 - it / 240
    for (let i = 0; i < P.length; i++) {
      const p = P[i]
      for (let j = i + 1; j < P.length; j++) {
        const q = P[j]
        if (q.sl !== p.sl) continue
        let dx = q.x - p.x, dy = (q.y - p.y) * 2
        let d2 = dx * dx + dy * dy
        if (d2 > 100) continue
        if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02 }
        const f = (8 * a) / d2
        p.vx -= dx * f; p.vy -= (dy * f) / 2; q.vx += dx * f; q.vy += (dy * f) / 2
      }
      // its place in time, and the island's middle row
      p.vx += (p.tx - p.x) * 0.04 * a
      p.vy += ((p.y0 + p.y1) / 2 - p.y) * 0.02 * a
    }
    for (const [i, j] of springs) {
      const p = P[i], q = P[j]
      const dx = q.x - p.x, dy = (q.y - p.y) * 2
      const d = Math.max(0.1, Math.hypot(dx, dy))
      const f = ((d - 4) * 0.2 * a) / d
      p.vx += dx * f; p.vy += (dy * f) / 2; q.vx -= dx * f; q.vy -= (dy * f) / 2
    }
    for (const p of P) {
      p.vx *= 0.6; p.vy *= 0.6
      p.x = Math.max(p.x0, Math.min(p.x1, p.x + Math.max(-3, Math.min(3, p.vx))))
      p.y = Math.max(p.y0, Math.min(p.y1, p.y + Math.max(-1.5, Math.min(1.5, p.vy))))
    }
  }
  const pos = new Map()
  const taken = []
  const free = (x, y, b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && !taken.some(t => (t.y === y && Math.abs(t.x - x) < 4) || (Math.abs(t.y - y) === 1 && Math.abs(t.x - x) < 2))
  const near = (x0, y0, b) => {
    for (let r = 0; r <= Math.max(W, H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -2 * r; dx <= 2 * r; dx++) {
          if (Math.abs(dy) !== r && Math.abs(dx) < 2 * r - 1) continue
          if (free(x0 + dx, y0 + dy, b)) return { x: x0 + dx, y: y0 + dy }
        }
      }
    }
    return null
  }
  const all = { x0: 0, x1: W - 2, y0: 1, y1: H - 1 }
  let fits = true
  for (const p of P) {
    const x0 = Math.round(p.x), y0 = Math.round(p.y)
    let got = near(x0, y0, p) || near(x0, y0, p.box)
    if (!got) { fits = false; got = near(x0, y0, all) || { x: Math.max(0, Math.min(W - 2, x0)), y: Math.max(1, Math.min(H - 1, y0)) } }
    taken.push(got)
    pos.set(p.id, got)
  }
  const names = slots.map(sl => ({ id: sl.g.id, name: cut(sl.g.name, Math.max(4, sl.w - 2)), x: sl.x, y: sl.y }))
  return { pos, names, fits }
}

/** The layout with the rows it leaves blank taken out: none above its first row used (a dot or a name), at most one
 *  between two rows used, one over each row of names but the first, and its height the rows left. */
export function trim(lay) {
  const used = new Set([...[...lay.pos.values()].map(p => p.y), ...lay.names.map(n => n.y)])
  const rows = [...used].sort((p, q) => p - q)
  const to = new Map()
  let y = 0
  const named = new Set(lay.names.map(n => n.y))
  // a blank row stays where the layout left one, and stands over each row of names but the first
  rows.forEach((r, i) => { if (i && (r - rows[i - 1] > 1 || named.has(r))) y += 1; to.set(r, y); y += 1 })
  const pos = new Map([...lay.pos].map(([id, p]) => [id, { x: p.x, y: to.get(p.y) }]))
  return { pos, names: lay.names.map(n => ({ ...n, y: to.get(n.y) })), h: Math.max(1, y), fits: lay.fits }
}

/** The rows a ref names without the value it picks: `q4#user=Kestrel@n` and `@share` are the same rows. */
const rowsOf = ref => String(ref).replace(/@[^@#/]*$/, '')
/** The column a ref picks: `q4#user=Kestrel@share` picks share; none for a ref with no `@`. */
const colOf = ref => (/@([^@#/]*)$/.exec(String(ref)) || [])[1] || null

/** A claim's evidence: its citations, those that name the same rows together, at most MAX_EVIDENCE. [[source]] */
export function evidenceOf(c) {
  const out = []
  for (const s of c.sources || []) {
    const hit = out.find(g => !quoted(s) && !quoted(g[0]) && rowsOf(g[0].ref) === rowsOf(s.ref))
    if (hit) hit.push(s)
    else out.push([s])
  }
  return out.slice(0, MAX_EVIDENCE)
}

const fmtVal = v => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : String(+v.toPrecision(4))) : v == null ? '' : String(v))
/** The query a ref cites a value of (`r2` of `r2#group=male@n`), or null for a row of a file. */
const queryOf = ref => (/^([qr]\d+)(?:#|$)/.exec(String(ref)) || [])[1] || null
/** Whether a piece of evidence is read as its quote (the folder's map quotes a row of a file); a value a query computed
 *  is read through the kernel, as a citation in an answer is. */
const quoted = s => !!s.quote && !queryOf(s.ref)
const pad = (s, n, right) => { const t = cut(s, n); const sp = ' '.repeat(Math.max(0, n - Array.from(t).length)); return right ? sp + t : t + sp }

/** A query's row a citation names, from the kernel's resolve: {about, row, more} (more: the other rows it names), or
 *  null when the citation names no row of a query, or is not read yet. */
export function queryRow(got) {
  if (!got || got.error) return null
  const q = (got.chain || []).find(x => x.step === 'query')
  const rows = q && Array.isArray(q.rows) ? q.rows.filter(r => r && typeof r === 'object') : []
  return rows.length ? { about: String(q.about || q.id || ''), row: rows[0], more: rows.length - 1 } : null
}

/**
 * One row of evidence that is no query's row, as markup: a row of a file as its text, the folder's evidence as its
 * quote, a citation still being read, or one that does not resolve.
 */
export function evidenceWords(k, cites, got) {
  const e = k.escape
  const s0 = cites[0]
  const labels = cites.map(s => s.label || s.ref).join(', ')
  if (quoted(s0)) return `{cite:“${e(one(s0.quote))}”} {dim:${e(shortRef(s0.ref))}}`
  if (!got) return `{cite:${e(labels)}} {dim:reading its rows…}`
  const words = chainWords(got)
  if (words.error) return `{cite:${e(labels)}} {bad:does not resolve:} {dim:${e(words.notes[0] || '')}}`
  const rec = (got.records || [])[0]
  if (rec && rec.text) return `{cite:${e(labels)}} {dim:${e(shortRef(rec.ref))}} ${e(one(rec.text))}`
  return `{cite:${e(labels)}} {dim:${e(words.line)}}`
}

/**
 * A claim's evidence as rows under its sentence. The rows it cites of one query are a small table: the query's name
 * over the rows' names, its columns over their values, the values the claim cites marked. A row of a file is its text,
 * the folder's evidence its quote. Each row is a part (ev-N) that a press opens as a citation opens.
 *
 *   survival by sex and class    n  survived   rate
 *   female, class 1             94        91  0.968
 *   female, class 3            144        72    0.5
 */
export function evidenceRows(k, evidence) {
  const e = k.escape
  const out = []
  const gots = evidence.map(g => (quoted(g[0]) ? null : k.want({ rows: [g[0].ref] })))
  const part = (j, node) => k.region(`ev-${j + 1}`, { label: `evidence: ${evidence[j].map(s => s.label).join(', ')}`, ref: evidence[j][0].ref }, node)
  const done = new Set()
  evidence.forEach((g, i) => {
    if (done.has(i)) return
    const q = quoted(g[0]) ? null : queryOf(g[0].ref)
    const same = q ? evidence.map((_, j) => j).filter(j => !done.has(j) && !quoted(evidence[j][0]) && queryOf(evidence[j][0].ref) === q) : []
    const rows = same.map(j => queryRow(gots[j]))
    if (!same.length || !rows.every(Boolean)) {
      done.add(i)
      out.push(part(i, k.text(`  ${evidenceWords(k, g, gots[i])}`, { wrap: false })))
      return
    }
    same.forEach(j => done.add(j))
    // the leading columns that hold words name each row; the others are its values
    const cols = Object.keys(rows[0].row).filter(c => c !== 'i')
    let lead = 0
    while (lead < cols.length - 1 && rows.every(r => typeof r.row[cols[lead]] === 'string')) lead++
    const nameOf = r => cols.slice(0, lead).map(c => fmtVal(r.row[c])).join(', ')
    const vals = cols.slice(lead)
    const about = cut(rows[0].about, 40)
    const nw = Math.max(Array.from(about).length, ...rows.map(r => Array.from(nameOf(r)).length))
    const cw = vals.map(c => Math.max(Array.from(c).length, ...rows.map(r => Array.from(fmtVal(r.row[c])).length)))
    out.push(k.text(`  {dim:${e(pad(about, nw))}${vals.map((c, x) => `  ${e(pad(c, cw[x], true))}`).join('')}}`, { wrap: false }))
    same.forEach((j, x) => {
      const r = rows[x]
      const cited = new Set(evidence[j].map(s => colOf(s.ref)).filter(Boolean))
      const cells = vals.map((c, y) => { const v = e(pad(fmtVal(r.row[c]), cw[y], true)); return cited.has(c) ? `  {cite:**${v}**}` : `  ${v}` }).join('')
      const more = r.more ? `  {dim:and ${r.more} more row${r.more === 1 ? '' : 's'}}` : ''
      out.push(part(j, k.text(`  ${e(pad(nameOf(r), nw))}${cells}${more}`, { wrap: false })))
    })
  })
  return out
}

const slim = c => ({
  id: c.id, text: c.text, by: c.by, cluster: c.cluster ?? null, turn: c.turn ?? null, n: c.n || 1,
  ...(c.revised_by ? { revised_by: c.revised_by } : {}), ...(c.revises ? { revises: c.revises } : {}),
  ...(c.folder ? { folder: true } : {}), ...(c.links && c.links.length ? { links: c.links.map(l => ({ to: l.to, how: l.how })) } : {}),
  sources: (c.sources || []).slice(0, 8).map(s => ({ ref: s.ref, label: s.label || s.ref, ...(s.quote ? { quote: s.quote } : {}) })),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row ?? null, by: s.by, turn: s.turn ?? null, quote: s.quote || '', sentence: s.sentence || '', ...(s.start != null ? { start: s.start, end: s.end } : {}), ...(s.ref ? { ref: s.ref } : {}) })),
})

export default {
  name: 'claims',
  title: 'Claims',
  titleOf: args => (args && args.source ? 'Where it was said' : 'Claims'),
  reads: args => (args && args.source ? ['claims', ...(args.row ? [`record:${args.row}`] : [])] : ['claims', 'threads']),
  stateKey: args => (args && args.source ? `claims-source-${String(args.source).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40)}` : 'claims'),
  data(stores, args) {
    const store = stores.claims && Array.isArray(stores.claims.claims) ? stores.claims : { claims: [], clusters: [], gaps: [] }
    const view = viewOf({ clusters: [], gaps: [], ...store })
    const claims = view.flat.map(slim)
    const groups = view.groups.map((g, i) => ({ id: g.id ?? null, name: g.name, folder: g.from === 'folder', i }))
    if (args && args.source) {
      const rec = args.row ? stores[`record:${args.row}`] : null
      return { source: claims.find(c => c.id === args.source) || null, text: rec ? String(rec.text || '') : '', groups }
    }
    // the panel's thread (one per pane: shell/side.ts) and whether it has a conversation, which takes rows under the pane
    const key = threadKey({ pane: 'claims', key: 'claims' })
    const talk = (Array.isArray(stores.threads) ? stores.threads : []).some(t => t && t.key === key && (t.turns || []).length)
    return {
      talk, total: view.total, clusters: view.clusters, last: view.last, gaps: (view.gaps || []).slice(-3),
      claims, groups, edges: edgesOf(view.flat),
      offer: store.offer || null, folder: store.folder || null, asked: store.folderAsked || null,
    }
  },
  // what the panel's thread is about, beside the part selected (shell/side.ts): the claim selected, or the place it was
  // said. Text a model reads (the thread's agent), logged with the prompts
  thread(args, state, data) {
    if (args && args.source) {
      const c = data && data.source
      return c ? { about: `where the claim "${cut(c.text, 200)}" was said (${whenOf(c) || 'this session'})`, label: `where "${cut(c.text, 60)}" was said` } : { about: 'where a claim was said' }
    }
    const c = ((data && data.claims) || []).find(x => x.id === (state && state.claim))
    if (!c) return { about: 'the claims of this session as a graph, in clusters' }
    const said = (c.said || []).find(x => x.sentence || x.quote)
    return { about: `the claims of this session as a graph, in clusters; the claim selected is "${cut(c.text, 200)}" (${whenOf(c) || 'this session'}${said ? `, said as "${cut(said.sentence || said.quote, 240)}"` : ''})` }
  },
  program,
}

export function program(k, data) {
  if (data.source !== undefined) return sourceView(k, data)
  const st = k.state || {}
  const W = Math.max(40, k.w)
  const claims = data.claims || []
  const byId = new Map(claims.map(c => [c.id, c]))
  const groups = data.groups || []
  const gi = new Map(groups.map(g => [String(g.id), g.i]))
  const tone = c => toneOf(gi.get(String(c.cluster)) ?? 0)

  // ---- the head: how many claims, and the folder's action while it has no map
  const head = [headLine(k, data)]
  for (const g of data.gaps || []) head.push(k.text(`{bad:Turn ${g.turn} was not read:} {dim:${k.escape(cut(g.why || 'the check of the answer failed', W - 24))}}`, { wrap: false }))
  if (!claims.length) {
    head.push(k.text(' '))
    head.push(k.text('{dim:No claims yet. After each answer, the statements in it come here.}'))
    return k.stack(head)
  }

  // ---- what is selected: the claim the state names, else the newest (of the last turn, the last said)
  const num = c => Number(/\d+$/.exec(String(c.id))?.[0] || 0)
  const newest = claims.reduce((b, c) => ((c.turn ?? -1) > (b.turn ?? -1) || ((c.turn ?? -1) === (b.turn ?? -1) && num(c) > num(b)) ? c : b))
  // after a turn that came since the selection, the pane opens on what is new: the turn's newest correction, else its
  // newest claim
  const fixes = claims.filter(c => c.revises && c.turn != null && c.turn === newest.turn)
  const fresh = st.at != null && data.last != null && st.at < data.last
  const claim = (!fresh && byId.get(st.claim)) || (fixes.length ? fixes.reduce((b, c) => (num(c) > num(b) ? c : b)) : newest)
  const evidence = evidenceOf(claim)
  // the claim's history: the claims it corrected and those that corrected it, oldest first
  const history = historyOf(claim, byId)
  const open = st.open === 'ev' || (st.open === 'hist' && history.length > 1) ? st.open : null
  const shown = open === 'ev' ? evidence.map((_, i) => `ev-${i + 1}`) : open === 'hist' ? history.filter(c => c.id !== claim.id).map(c => `was-${c.id}`) : []
  const rowsHere = new Set(['said', ...shown])
  const at = data.last ?? null
  const pick = id => (byId.has(id) ? { claim: id, part: nodeRegion(id), at, open: st.open ?? null } : null)
  const nodeOf = r => claims.find(c => nodeRegion(c.id) === r) || null
  const part = !fresh && st.part && (rowsHere.has(st.part) || st.part === nodeRegion(claim.id)) ? st.part : nodeRegion(claim.id)

  // ---- what the person does
  k.on('focus', e => {
    const n = nodeOf(e.region)
    if (n) return pick(n.id)
    if (rowsHere.has(String(e.region))) return { claim: claim.id, part: String(e.region), at, open: st.open ?? null }
    return null
  })
  const openSource = c => {
    const said = (c.said || []).find(x => x.by !== 'folder' && x.row)
    // a claim of the folder's map came from its first evidence row: that opens as a citation does
    if (!said && c.sources && c.sources[0]) { k.do('open', { mark: { kind: 'cite', ref: c.sources[0].ref, label: c.sources[0].quote || c.sources[0].label } }); return }
    if (said) k.do('source', { id: c.id, row: said.row })
  }
  const openEvidence = g => { if (g) k.do('open', { mark: { kind: 'cite', ref: g[0].ref, label: g[0].label || g[0].ref } }) }
  k.on('press', e => {
    const r = String(e.region || '')
    const n = nodeOf(r)
    // a press on the dot selected opens where it was said; on another dot it selects that one
    if (n) { if (n.id === claim.id) { openSource(n); return null } return pick(n.id) }
    if (r === 'said') { openSource(claim); return null }
    const ev = /^ev-(\d+)$/.exec(r)
    if (ev) { openEvidence(evidence[Number(ev[1]) - 1]); return null }
    // a version in the history: that claim selected, the history kept open
    if (r.startsWith('was-') && byId.has(r.slice(4))) return pick(r.slice(4))
    if (r === 'folder') { k.do('folder'); return null }
    return null
  })
  const step = dir => () => {
    const i = claims.findIndex(c => c.id === claim.id)
    return pick(claims[(i + dir + claims.length) % claims.length].id)
  }
  k.on('up', step(-1), 'move')
  k.on('down', step(1), 'move')
  // ↵ presses what the ring is on (Claude Code's own press); the bar says what that does there, in a word that reads
  // alone (a narrow bar keeps only the first)
  const enter = /^ev-/.test(part) || (claim.folder && !(claim.said || []).some(x => x.row)) ? 'rows' : /^was-/.test(part) ? 'version' : 'message'
  k.on('return', () => null, enter)
  // the actions above the side panel's input bar, in words, each opening what it names right above them: the rows the
  // claim cites, and, when it was corrected or corrects another, its history. e and h do the same while the input bar
  // is empty
  const toggle = what => () => ({ open: st.open === what ? null : what, part: nodeRegion(claim.id) })
  k.on(open === 'ev' ? 'act:ev:on' : 'act:ev', toggle('ev'), 'e evidence')
  k.on('e', toggle('ev'))
  if (history.length > 1) {
    k.on(open === 'hist' ? 'act:hist:on' : 'act:hist', toggle('hist'), 'h history')
    k.on('h', toggle('hist'))
  }
  k.select(part)

  // ---- the claim selected, under the graph: its full sentence; what an action opened stands above the input bar
  const rowsFor = x => 1 + Math.min(MAX_SENTENCE, wrap(`${x.text} · ${saidWords(x)}`, W - 3).length)
  const panel = claimRows(k, { claim, tone })
  const opened = open === 'ev' ? [k.region('side:opened', { label: `the rows "${cut(claim.text, 60)}" cites` }, k.stack(evidence.length ? evidenceRows(k, evidence) : [k.text('{dim:It cites no rows.}', { wrap: false })]))]
    : open === 'hist' ? [k.region('side:opened', { label: `the history of "${cut(claim.text, 60)}"` }, k.stack(historyRows(k, history, claim, tone)))] : []

  // ---- the graph, in the rows left: the rows under it are those of the tallest claim's, so the graph keeps its size and
  // its dots their places while the ring walks them. A conversation under the pane takes about two fifths of the rows,
  // the input bar, the actions above it and the gaps between eight, and what an action opened about two fifths more
  const all = k.h || 40
  const H = Math.max(12, all - 8 - (data.talk ? Math.floor(all * 0.4) : 0) - (open ? Math.floor(all * 0.4) : 0))
  const tallest = Math.max(...claims.map(rowsFor))
  const room = Math.max(6, H - head.length - 1 - Math.max(tallest, panel.length))
  // the claims linked to the one selected are drawn bold, at the far end of its bright lines
  const edges = data.edges || []
  const near = new Set(edges.filter(e => e.kind !== 'corrects' && (e.a === claim.id || e.b === claim.id)).map(e => (e.a === claim.id ? e.b : e.a)))
  // the session's clusters, then the folder's map under its own line, each laid out in its share of the rows
  const mine = groups.filter(g => !g.folder)
  const theirs = groups.filter(g => g.folder)
  const inGroups = gs => { const ids = new Set(gs.map(g => String(g.id))); return claims.filter(c => ids.has(String(c.cluster)) || (gs === mine && !groups.some(g => String(g.id) === String(c.cluster)))) }
  const parts = [[mine, inGroups(mine)], [theirs, inGroups(theirs)]].filter(([gs, cs]) => gs.length && cs.length)
  // each graph gets the rows it needs to fit with every cluster's name whole, and the session's graph the rows left
  // over; with too few rows for that, each gets its share by its claims
  const leads = parts.map(([gs], pi) => (pi ? 1 : 0) + (gs === theirs ? 1 : 0))
  const needs = parts.map(([gs, cs]) => needOf(cs, gs, edges, W, room))
  const free = room - leads.reduce((a, b) => a + b, 0)
  const sum = needs.reduce((a, b) => a + b, 0)
  const rows = sum <= free ? needs.map((n, i) => (i ? n : n + free - sum)) : parts.map(([, cs]) => Math.max(4, Math.round((free * cs.length) / claims.length)))
  const graph = []
  parts.forEach(([gs, cs], pi) => {
    if (pi) graph.push(k.text(' '))
    if (gs === theirs) graph.push(k.text(`{dim:the whole folder's map · ${cs.length} claim${cs.length === 1 ? '' : 's'}}`, { wrap: false }))
    graph.push(graphOf(k, { claims: cs, groups: gs, edges, W, h: rows[pi], claim, near, tone, num }).canvas)
  })
  return k.stack(...head, k.text(' '), ...graph, ...panel, ...opened)
}

// the layouts made lately, by what they were made of: the network does not change while the ring walks its dots, and a
// layout takes the most time of a drawing, so each key that moves the selection draws from here
const LAYOUTS = new Map()
const MAX_LAYOUTS = 24

/** The laid-out graph of these claims and clusters in h rows (trimmed), and whether it fits with every name whole. */
function layOf(claims, groups, edges, W, h, num) {
  const order = claims.slice().sort((p, q) => (p.turn ?? 0) - (q.turn ?? 0) || num(p) - num(q))
  const named = groups.map(g => ({ id: g.id, name: g.name }))
  const nodes = order.map(c => ({ id: c.id, cluster: c.cluster }))
  const key = JSON.stringify([W, h, nodes, named, (edges || []).map(e => [e.a, e.b])])
  let got = LAYOUTS.get(key)
  if (!got) {
    const lay = trim(layout(nodes, named, edges, { w: W, h }))
    const whole = lay.names.every(nm => !nm.name.endsWith('…') || named.some(g => String(g.id) === nm.id && g.name.endsWith('…')))
    got = { lay, ok: lay.fits && whole }
    LAYOUTS.set(key, got)
    if (LAYOUTS.size > MAX_LAYOUTS) LAYOUTS.delete(LAYOUTS.keys().next().value)
  }
  return got
}

/** The fewest rows a graph needs: the first height at which every cluster's rectangle holds its dots (gridOf's
 *  capacity, cheap to reckon) and every name is whole, or `most` when none up to it does. The network is laid out once,
 *  at the height chosen. */
function needOf(claims, groups, edges, W, most) {
  const named = groups.map(g => ({ id: String(g.id), name: String(g.name), nodes: claims.filter(c => String(c.cluster) === String(g.id)) })).filter(g => g.nodes.length)
  for (let h = 4; h <= most; h += 2) {
    const slots = slotsOf(named, Math.max(20, W), h)
    if (slots.every(sl => gridOf(sl.g.nodes.length, sl.w - 6, sl.h - 1).fits && Array.from(sl.g.name).length <= Math.max(4, sl.w - 2))) return h
  }
  return most
}

/** One graph of clusters: their names, their claims as dots, and the links between them. As many rows as `h`; a graph
 *  that does not fit there takes more rows, and the side panel shows the rows around the dot selected. */
function graphOf(k, { claims, groups, edges, W, h, claim, near, tone, num }) {
  let lay = layOf(claims, groups, edges, W, h, num).lay
  for (let hh = h + 4; !lay.fits && hh <= h + 200; hh += 4) lay = layOf(claims, groups, edges, W, hh, num).lay
  const c = k.canvas(W, lay.h)
  for (const nm of lay.names) {
    const gg = groups.find(x => String(x.id) === nm.id)
    // no-break spaces, so no line drawn after it runs through a name
    c.text(nm.x, nm.y, `{${toneOf(gg ? gg.i : 0)}:${k.escape(nm.name).replace(/ /g, '\u00a0')}}`)
  }
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (!p) continue
    c.dot(p.x, p.y, tone(x), { glyph: dotOf(x), bold: x.id === claim.id || near.has(x.id), part: nodeRegion(x.id), meta: { label: `claim: ${x.text}`, ref: (x.sources || []).map(s => s.ref).slice(0, 6) } })
  }
  for (const { e, bright } of linesOf(edges, lay.pos, claims, claim.id)) {
    const a = lay.pos.get(e.a), b = lay.pos.get(e.b)
    c.link(a.x, a.y, b.x, b.y, edgeTone(e, bright))
  }
  return { canvas: c, h: lay.h }
}

/**
 * The lines a graph draws, in the order drawn (a cell a line took stays its). A line joins two claims related in meaning
 * (supports, the same topic, contradicts) or drawing on the same rows; a correction is no line, since the corrected
 * claim shows it (a hollow dot, its history). Every line of the claim selected, bright; then, faint, each line between
 * two claims of one cluster where it crosses no dot (a line through a dot reads as two). A line to a claim of another
 * cluster is drawn only for the claim selected, so a hundred claims never hide under their lines. [{e, bright}]
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

/** The head: how many claims the session holds, then the folder's action (a press), or that Claude is reading it. */
function headLine(k, data) {
  const n = data.total || 0
  const count = k.text(`{c2:**${n ? `${n.toLocaleString('en-US')} claim${n === 1 ? '' : 's'}` : 'Claims'}**}`, { wrap: false })
  if (data.folder) return count
  if (data.asked) return k.beside(count, k.text("{dim:Claude is reading the whole folder for its claims…}", { wrap: false }), { gap: 3 })
  if (data.offer) return k.beside(count, k.region('folder', { label: `add the claims of the whole folder: ${data.offer.what}` }, k.text("{accent:add the whole folder's claims}", { wrap: false })), { gap: 3 })
  return count
}

/** The claim selected, as rows under the graph: its full sentence (a press opens where it was said), with who said it
 *  and how often; a corrected claim's dot is hollow. */
function claimRows(k, { claim, tone }) {
  const e = k.escape
  const who = saidWords(claim)
  const sentence = k.beside(
    k.text(`{${tone(claim)}:${dotOf(claim)}}`, { wrap: false, w: 1 }),
    k.text(`**${e(sentenceOf(claim.text))}**${who ? ` {dim:· ${e(who)}}` : ''}`, { max: MAX_SENTENCE }),
    { gap: 1 },
  )
  return [k.text(' '), k.region('said', { label: `where "${cut(claim.text, 60)}" was said`, ref: (claim.sources || []).map(x => x.ref).slice(0, 6) }, sentence)]
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

/** The history as rows: each version, oldest first, with where it was said (who, and the words); the one selected bold,
 *  each other a press that selects it. */
function historyRows(k, history, claim, tone) {
  const e = k.escape
  const out = []
  for (const c of history) {
    const said = (c.said || []).find(x => x.sentence || x.quote)
    const who = c.by === 'person' ? 'you said' : c.by === 'folder' ? "the folder's map" : 'Claude said'
    const line = `{${tone(c)}:${dotOf(c)}} ${c.id === claim.id ? `**${e(sentenceOf(c.text))}**` : e(sentenceOf(c.text))}`
    const where = said ? `  {dim:${who}} “${e(one(said.sentence || said.quote))}”` : `  {dim:${who}}`
    const rows = [k.text(line, { wrap: false }), k.text(where, { wrap: false })]
    out.push(c.id === claim.id ? k.stack(rows) : k.region(`was-${c.id}`, { label: `claim: ${c.text}`, ref: (c.sources || []).map(x => x.ref).slice(0, 6) }, k.stack(rows)))
  }
  return out
}

/** Where a claim was said: the message that said it as the person reads it, the claim's words marked, and the other
 *  places it was said. */
function sourceView(k, data) {
  const W = Math.max(40, k.w)
  const c = data.source
  if (!c) return k.text('{dim:That claim is not in this session any more.}')
  const said = (c.said || []).filter(x => x.by !== 'folder')
  const first = said[0] || null
  const who = first ? (first.by === 'person' ? 'your message' : "Claude's message") : ''
  const lines = [k.text(`{c2:**Where it was said**}  {dim:${k.escape(who)}}`, { wrap: false }), k.text(' ')]
  const seg = r => k.text(r.map(x => (x.on ? `{accent:**${k.escape(x.s)}**}` : k.escape(x.s))).join(''), { wrap: false })
  // the claim's words are marked in their color; the view has no part to select, and the panel's thread is about the
  // place (thread())
  const msg = first && data.text ? messageRows(data.text, first, W - 1) : null
  if (msg) msg.rows.forEach(r => lines.push(seg(r)))
  else if (first) lines.push(k.text(`{accent:**“${k.escape(cut(first.sentence || first.quote, W - 4))}”**}`, { wrap: false }))
  const again = said.slice(1)
  if (again.length) {
    lines.push(k.text(' '))
    lines.push(k.text('{dim:also said}'))
    for (const p of again) lines.push(k.text(`${p.by === 'person' ? '{dim:you} ' : ''}“${k.escape(cut(p.sentence || p.quote, W - 8))}”`, { wrap: false }))
  }
  return k.stack(lines)
}

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
  let len = 0
  const re = /\S+/g
  let m
  while ((m = re.exec(plain))) {
    const w = m[0].length > n ? m[0].slice(0, n - 1) + '…' : m[0]
    const on = marked.slice(m.index, m.index + m[0].length).some(Boolean)
    if (len && len + 1 + w.length > n) { lines.push(cur); cur = []; len = 0 }
    if (cur.length) cur.push({ s: ' ', on: on && cur[cur.length - 1].on })
    cur.push({ s: w, on })
    len += (len ? 1 : 0) + w.length
  }
  if (cur.length) lines.push(cur)
  return lines
}
