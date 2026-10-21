// graph.js: the Claims pane, a program on the card runtime (draw/kit.js) over the session's claims (store.js). It opens
// in the side panel (claims/term.ts openSide), nearly the whole terminal wide (`wide`), and is one view: the graph, and
// the claim selected in a box over it.
//
//   the head        how many claims the session holds, and one action while the folder has no map yet: a press that
//                   asks Claude to add the claims of the whole folder (never a key, since it starts a turn)
//   the graph       the whole pane wide: each cluster a loose group of dots in its own color, its name in plain gray
//                   among them, the clusters spread over the pane, linked claims near each other; a hollow dot is a
//                   claim a later one corrected, a heavier one a claim said twice or more. A line means one thing: the
//                   two claims are related in meaning or draw on the same rows. At rest the lines inside a cluster are
//                   faint, drawn only where they cross no dot. A correction is no line: the corrected claim is hollow,
//                   and its history says what corrected it. The dots keep their places while the ring walks them
//   the claim       once a claim is selected (a ↑↓ or a press): every other dot and name dims, the claim's lines are
//                   drawn, and a framed box opens over the graph near its dot: its full sentence in bold (a press, or
//                   ↵ on its dot, opens the message that said it, its words marked, over the pane, as a citation
//                   opens), and under it what an action opened
//   actions         above the side panel's input bar, in words (e and h do the same while the input bar is empty), each
//                   opening what it names in the box: e evidence, the rows the claim cites as small tables, the
//                   values it cites marked (a press opens one as a citation); h history, only for a claim corrected or
//                   correcting another, its versions oldest first with who said each and its words (a press selects one)
//   where it was said   the same module with args {source}: the message that said the claim, its words marked, and
//                   the other places it was said
//
// What can be pressed looks like it can (a color, the ring), so the pane prints no captions, legends or turn numbers.
// The side panel holds the keys: ↑↓ (and tab) walk the claims in the order they are listed, cluster by cluster (this
// program's up and down: the host turns each move of Claude Code's ring from the selected dot into one of them, so the
// walk never depends on where the dots stand), ← → go to the cluster before or after (its first claim), and the panel's
// input bar asks its thread about the claim. The other
// presses (the head's, the rows in the box) are a click away; ↵ on the dot opens where it was said.
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

export const nodeRegion = id => `n-${String(id).replace(/[^A-Za-z0-9_.:-]/g, '-')}`
/** A cluster's color: the six categorical tones in turn. */
export const toneOf = i => `c${(Math.max(0, i) % 6) + 1}`
/** A claim's dot: hollow once corrected, heavier when said twice or more. */
export const dotOf = c => (c.revised_by ? '○' : (c.n || 1) >= 2 ? '◉' : '●')
/** A line's tone. A line means one thing, the two claims are related in meaning or draw on the same rows, so every line
 *  has one look, a thin gray line: darker for the claim selected, faint for the rest. */
export const edgeTone = (e, bright) => (bright ? 'dim' : 'dim-faint')

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

const hash = s => {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

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
 * of the cell, a little off centre by its hash, and its claims a loose ring round the name, linked claims next to each
 * other. Each claim is snapped to a cell so no two dots crowd (four blank cells between two dots of one row when there is
 * room, one between dots of rows next to each other) and no dot touches a name: first inside its cluster's cell, else
 * anywhere. Deterministic. {pos: Map(id -> {x, y}), names: [{id, name, x, y}], h}
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
    const len = Array.from(name).length
    const cx = sl.x + sl.w / 2 + (hash(sl.g.id + 'x') - 0.5) * sl.w * 0.2
    const cy = sl.y + sl.h / 2 + (hash(sl.g.id + 'y') - 0.5) * sl.h * 0.2
    const x = Math.max(sl.x + 1, Math.min(sl.x + sl.w - len - 1, Math.round(cx - len / 2)))
    const y = Math.max(0, Math.min(H - 1, Math.round(cy - 0.5)))
    return { id: sl.g.id, name, x, y, len, cx, cy: y }
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
    // the ring: as wide as the cell allows, the dots round it in turn, each a little in or out by its hash
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
 * A claim's evidence as rows in its box: [{text, part}] (text: markup on one row; part: {id, meta} for a row a press
 * opens as a citation opens, else null). The rows it cites of one query are a small table: the query's name over the
 * rows' names, its columns over their values, the values the claim cites marked. A row of a file is its text, the
 * folder's evidence its quote.
 *
 *   survival by sex and class    n  survived   rate
 *   female, class 1             94        91  0.968
 *   female, class 3            144        72    0.5
 */
export function evidenceRows(k, evidence) {
  const e = k.escape
  const out = []
  const gots = evidence.map(g => (quoted(g[0]) ? null : k.want({ rows: [g[0].ref] })))
  const part = j => ({ id: `ev-${j + 1}`, meta: { label: `evidence: ${evidence[j].map(s => s.label).join(', ')}`, ref: evidence[j][0].ref } })
  const done = new Set()
  evidence.forEach((g, i) => {
    if (done.has(i)) return
    const q = quoted(g[0]) ? null : queryOf(g[0].ref)
    const same = q ? evidence.map((_, j) => j).filter(j => !done.has(j) && !quoted(evidence[j][0]) && queryOf(evidence[j][0].ref) === q) : []
    const rows = same.map(j => queryRow(gots[j]))
    if (!same.length || !rows.every(Boolean)) {
      done.add(i)
      out.push({ text: evidenceWords(k, g, gots[i]), part: part(i) })
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
    out.push({ text: `{dim:${e(pad(about, nw))}${vals.map((c, x) => `  ${e(pad(c, cw[x], true))}`).join('')}}`, part: null })
    same.forEach((j, x) => {
      const r = rows[x]
      const cited = new Set(evidence[j].map(s => colOf(s.ref)).filter(Boolean))
      const cells = vals.map((c, y) => { const v = e(pad(fmtVal(r.row[c]), cw[y], true)); return cited.has(c) ? `  {cite:**${v}**}` : `  ${v}` }).join('')
      const more = r.more ? `  {dim:and ${r.more} more row${r.more === 1 ? '' : 's'}}` : ''
      out.push({ text: `${e(pad(nameOf(r), nw))}${cells}${more}`, part: part(j) })
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
  // the graph wants the room: the side panel docks nearly the whole terminal wide for it (shell/detail.tsx dockColumns)
  wide: true,
  // the ring starts on the selected dot, so the first ↑ or ↓ walks the claims from it (the source view has no part)
  ringStart: args => (args && args.source ? null : 'part'),
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
  // ← → go to the cluster before or after, on its first claim
  const hop = dir => () => {
    const order = [...new Set(claims.map(c => String(c.cluster)))]
    const to = order[(order.indexOf(String(claim.cluster)) + dir + order.length) % order.length]
    const first = claims.find(c => String(c.cluster) === to)
    return first ? pick(first.id) : null
  }
  k.on('left', hop(-1))
  k.on('right', hop(1))
  // ↵ presses what the ring is on (Claude Code's own press); the bar says what that does there, in a word that reads
  // alone (a narrow bar keeps only the first)
  const enter = /^ev-/.test(part) || (claim.folder && !(claim.said || []).some(x => x.row)) ? 'rows' : /^was-/.test(part) ? 'version' : 'message'
  k.on('return', () => null, enter)
  // the actions above the side panel's input bar, in words, each opening what it names in the claim's box: the rows the
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

  // ---- the graph, the whole pane wide, in the rows the panel leaves it: a conversation under the pane takes about
  // two fifths of them, the input bar, the actions above it and the gaps between eight. The claim's box stands over
  // the graph, so the graph keeps its size and its dots their places while the ring walks them
  const all = k.h || 40
  const H = Math.max(10, all - 8 - (data.talk ? Math.floor(all * 0.4) : 0))
  const room = Math.max(6, H - head.length - 1)
  // a claim is selected once the person moved to it or opened its box: then every other claim dims
  const chosen = (!fresh && byId.has(st.claim)) || !!open
  const edges = data.edges || []
  const near = new Set(edges.filter(e => e.kind !== 'corrects' && (e.a === claim.id || e.b === claim.id)).map(e => (e.a === claim.id ? e.b : e.a)))
  // the session's clusters, then the folder's map under its own line, each in its share of the rows
  const mine = groups.filter(g => !g.folder)
  const theirs = groups.filter(g => g.folder)
  const inGroups = gs => { const ids = new Set(gs.map(g => String(g.id))); return claims.filter(c => ids.has(String(c.cluster)) || (gs === mine && !groups.some(g => String(g.id) === String(c.cluster)))) }
  const parts = [[mine, inGroups(mine)], [theirs, inGroups(theirs)]].filter(([gs, cs]) => gs.length && cs.length)
  const leads = parts.map(([gs], pi) => (pi ? 1 : 0) + (gs === theirs ? 1 : 0))
  const free = room - leads.reduce((a, b) => a + b, 0)
  const rows = parts.length > 1 ? parts.map(([, cs], pi) => (pi ? free - Math.max(4, Math.round((free * parts[0][1].length) / claims.length)) : Math.max(4, Math.round((free * cs.length) / claims.length)))) : [free]
  const graph = []
  parts.forEach(([gs, cs], pi) => {
    if (pi) graph.push(k.text(' '))
    if (gs === theirs) graph.push(k.text(`{dim:the whole folder's map · ${cs.length} claim${cs.length === 1 ? '' : 's'}}`, { wrap: false }))
    const here = cs.some(c => c.id === claim.id)
    graph.push(graphOf(k, { claims: cs, groups: gs, edges, W, h: rows[pi], claim, near, tone, num, chosen, box: chosen && here ? { open, evidence, history } : null }))
  })
  return k.stack(...head, k.text(' '), ...graph)
}

// the layouts made lately, by what they were made of: the network does not change while the ring walks its dots, and a
// layout takes the most time of a drawing, so each key that moves the selection draws from here
const LAYOUTS = new Map()
const MAX_LAYOUTS = 24

/** The laid-out graph of these claims and clusters in w × h cells. */
function layOf(claims, groups, edges, W, h, num) {
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

/** One graph of clusters: their names in plain gray, their claims as dots in the cluster's color, the links between
 *  them; with a claim selected (`chosen`), everything else dimmed, the claim's lines drawn, and its box over the graph
 *  near its dot. */
function graphOf(k, { claims, groups, edges, W, h, claim, near, tone, num, chosen, box }) {
  const lay = layOf(claims, groups, edges, W, h, num)
  const c = k.canvas(W, lay.h)
  const e = k.escape
  // the box: the claim's sentence in bold, and what an action opened under it
  let frame = null
  if (box) {
    const inner = Math.max(20, Math.min(W - 6, 92))
    const who = saidWords(claim)
    const all = wrap(`${sentenceOf(claim.text)}${who ? ` · ${who}` : ''}`, inner - 2)
    const words = all.slice(0, MAX_SENTENCE)
    // a sentence longer than the box's lines says so where it stops
    if (all.length > MAX_SENTENCE) words[MAX_SENTENCE - 1] = cut(words[MAX_SENTENCE - 1] + ' ' + all[MAX_SENTENCE], inner - 2)
    const said = words.map((l, i) => {
      // the words of who said it stay dim
      const at = who && i === words.length - 1 ? l.lastIndexOf(` · ${who}`) : -1
      const body = at >= 0 ? `**${e(l.slice(0, at))}**{dim:${e(l.slice(at))}}` : `**${e(l)}**`
      return { text: (i ? '  ' : `{${tone(claim)}:${dotOf(claim)}} `) + body, part: null }
    })
    const more = box.open === 'ev' ? (box.evidence.length ? evidenceRows(k, box.evidence) : [{ text: '{dim:It cites no rows.}', part: null }])
      : box.open === 'hist' ? historyRows(k, box.history, claim, tone) : []
    const lines = [...said, ...more].slice(0, Math.max(1, lay.h - 2))
    // the cells a line of markup takes: an escaped character is one cell (the braces of "{ }" in a claim's words
    // count), a tone's "{name:", its closing brace and ** take none
    const vis = t => k.len(String(t).replace(/\\(.)|\{[A-Za-z][\w-]*:|\*\*|[{}]/g, (m, esc) => esc ?? ''))
    const bw = Math.min(W, Math.max(30, ...lines.map(l => Math.min(inner, vis(l.text)))) + 4)
    const bh = lines.length + 2
    const p = lay.pos.get(claim.id)
    const at = boxAt(p, bw, bh, W, lay.h, [...near].map(id => lay.pos.get(id)).filter(Boolean))
    frame = { x: at.x, y: at.y, w: bw, h: bh, lines, said: said.length }
  }
  const short = ed => { const a = lay.pos.get(ed.a), b = lay.pos.get(ed.b); return Math.abs(a.x - b.x) <= 10 && Math.abs(a.y - b.y) <= 2 }
  const under = q => frame && q.x >= frame.x && q.x < frame.x + frame.w && q.y >= frame.y && q.y < frame.y + frame.h
  for (const nm of lay.names) {
    // no-break spaces, so no line drawn after it runs through a name
    c.text(nm.x, nm.y, `{${chosen ? 'dim-faint' : 'dim'}:${e(nm.name).replace(/ /g, ' ')}}`)
  }
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (!p || under(p)) continue
    const lit = !chosen || x.id === claim.id || near.has(x.id)
    c.dot(p.x, p.y, lit ? tone(x) : `${tone(x)}-faint`, { glyph: dotOf(x), bold: chosen && (x.id === claim.id || near.has(x.id)), part: nodeRegion(x.id), meta: { label: `claim: ${x.text}`, ref: (x.sources || []).map(s => s.ref).slice(0, 6) } })
  }
  if (frame) {
    c.box(frame.x, frame.y, frame.w, frame.h, { tone: 'dim', fill: true })
    frame.lines.forEach((l, i) => {
      c.text(frame.x + 2, frame.y + 1 + i, l.text, { max: frame.w - 4 })
      if (l.part) c.region(l.part.id, frame.x + 1, frame.y + 1 + i, frame.w - 2, 1, l.part.meta)
    })
    c.region('said', frame.x + 1, frame.y + 1, frame.w - 2, frame.said, { label: `where "${cut(claim.text, 60)}" was said`, ref: (claim.sources || []).map(x => x.ref).slice(0, 6) })
  }
  // the lines last, so each goes around the dots, the names and the box, or is not drawn (term.js): a line in pieces
  // reads as lines that join nothing
  for (const { e: ed, bright } of linesOf(edges, lay.pos, claims, claim.id)) {
    // at rest only the short lines inside a cluster, faint, so the clusters read first; once a claim is selected, only
    // its own
    if (chosen ? !bright : !short(ed)) continue
    const a = lay.pos.get(ed.a), b = lay.pos.get(ed.b)
    c.link(a.x, a.y, b.x, b.y, edgeTone(ed, bright && chosen))
  }
  return c
}

/**
 * The lines a graph draws, in the order drawn (lines that share a cell join there). A line joins two claims related in meaning
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

/** The head: Claims, how many and in how many clusters, then the folder's action (a press), or that Claude is reading it. */
function headLine(k, data) {
  const n = data.total || 0
  const groups = (data.groups || []).length
  const count = k.text(`{c2:**Claims**}${n ? `   {dim:${n.toLocaleString('en-US')}${groups > 1 ? ` · ${groups} clusters` : ''}}` : ''}`, { wrap: false })
  if (data.folder) return count
  if (data.asked) return k.beside(count, k.text("{dim:Claude is reading the whole folder for its claims…}", { wrap: false }), { gap: 3 })
  if (data.offer) return k.beside(count, k.region('folder', { label: `add the claims of the whole folder: ${data.offer.what}` }, k.text("{accent:add the whole folder's claims}", { wrap: false })), { gap: 3 })
  return count
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

/** The history as rows in the claim's box: each version, oldest first, with where it was said (who, and the words); the
 *  one selected bold, each other a press that selects it. [{text, part}] */
function historyRows(k, history, claim, tone) {
  const e = k.escape
  const out = []
  for (const c of history) {
    const said = (c.said || []).find(x => x.sentence || x.quote)
    const who = c.by === 'person' ? 'you said' : c.by === 'folder' ? "the folder's map" : 'Claude said'
    const part = c.id === claim.id ? null : { id: `was-${c.id}`, meta: { label: `claim: ${c.text}`, ref: (c.sources || []).map(x => x.ref).slice(0, 6) } }
    out.push({ text: `{${tone(c)}:${dotOf(c)}} ${c.id === claim.id ? `**${e(sentenceOf(c.text))}**` : e(sentenceOf(c.text))}`, part })
    out.push({ text: said ? `  {dim:${who}} “${e(one(said.sentence || said.quote))}”` : `  {dim:${who}}`, part })
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
