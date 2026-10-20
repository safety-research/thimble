// graph.js: the Claims pane, a program on the card runtime (draw/kit.js) over the session's claims (store.js). It opens
// in the side panel (claims/term.ts openSide) and is one view: the graph, and the claim selected under it.
//
//   the head        how many claims the session holds, and one action while the folder has no map yet: a press that
//                   asks Claude to add the claims of the whole folder (never a key, since it starts a turn)
//   the graph       each claim a dot, the claims of a cluster together in the cluster's color under its name (each
//                   cluster a rectangle of the graph, sized by how many claims it holds), in rows in the order they were
//                   said; a hollow dot is a claim a later one corrected, a heavier one a claim said twice or more. For
//                   the claim selected, a line joins it to each claim it is linked to (amber and dashed: the correction;
//                   blue: supports or same topic; red: contradicts, from the folder's map; gray: cites the same rows),
//                   and those dots are drawn bold. No other link is drawn, so the graph stays readable with a hundred
//                   claims. The dots keep their places while the ring walks them.
//   the claim       under the graph, the claim selected: its sentence (a press opens where it was said, over the pane, as
//                   a citation opens), then its evidence (the rows each citation names, with their numbers, the values
//                   it cites marked; a press opens the citation over the pane), then the claim that corrects it or that
//                   it corrects (a press selects it)
//   where it was said   the same module with args {source}: the message that said the claim, its words marked, and
//                   the other places it was said
//
// What can be pressed looks like it can (a color, the ring), so the pane prints no captions, legends or turn numbers.
// The side panel holds the keys: ↑↓ walk the claims, the ring (tab) walks the claim's rows and selects what it lands on
// (k.select), and the panel's input bar asks its thread about that.
//
//   state: {claim, part: the dot or row selected, at: the last turn when it was selected}
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
/** An edge's tone: a correction amber, a contradiction red, another link blue, the same rows gray. */
export const edgeTone = e => (e.kind === 'corrects' ? 'warn' : e.kind === 'relates' ? (e.how === 'contradicts' ? 'bad' : 'accent') : 'ink')

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

/** How a cluster of n dots fits a rectangle whose dots may use iw × ih cells: {sx, sy, per} (per: dots in a row, the
 *  rows as even as they can be), and whether it fits at all. */
export function gridOf(n, iw, ih) {
  for (const [sx, sy] of SPACINGS) {
    const most = Math.max(1, Math.floor((iw - 1) / sx) + 1)
    const rows = Math.ceil(n / most)
    if ((rows - 1) * sy + 1 <= ih) return { sx, sy, per: Math.ceil(n / rows), fits: true }
  }
  const [sx, sy] = SPACINGS[SPACINGS.length - 1]
  return { sx, sy, per: Math.max(1, Math.floor((iw - 1) / sx) + 1), fits: false }
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
        // the slot's top row holds the cluster's name; its dots want the airy spacing, and must fit the dense one
        const airy = gridOf(g.nodes.length, sl.w - 2, sl.h - 1)
        cost += Math.log(sl.w / Math.max(1, sl.h) / 5) ** 2 + (airy.fits ? (airy.sy === 1 ? 1 : 0) + (airy.sx < 3 ? 0.5 : 0) : 20) + (Array.from(g.name).length > sl.w - 2 ? 1 : 0)
        x += ws[gi]
      })
      y += hs[ri]
    })
    if (!best || cost < best.cost - 1e-9) best = { cost, out }
  }
  return best ? best.out : []
}

/**
 * The graph laid out in cells, w × h: each cluster a rectangle of the area (slotsOf) with its name on the top row and
 * its claims under it in rows, in the order `nodes` gives (the order they were said): earlier left, later right, then
 * the next row. So a cluster's claims are always together, apart from another's, and in time. Deterministic.
 * {pos: Map(id -> {x, y}), names: [{id, name, x, y}], fits}
 */
export function layout(nodes, clusters, { w, h }) {
  const W = Math.max(20, w)
  const H = Math.max(3, h)
  const known = new Set(clusters.map(c => String(c.id)))
  const groups = clusters.map(c => ({ id: String(c.id), name: String(c.name), nodes: nodes.filter(n => String(n.cluster) === String(c.id)) })).filter(g => g.nodes.length)
  const loose = nodes.filter(n => !known.has(String(n.cluster)))
  if (loose.length) groups.push({ id: '', name: 'between clusters', nodes: loose })
  const slots = slotsOf(groups, W, H)
  const pos = new Map()
  let fits = true
  for (const sl of slots) {
    const g = gridOf(sl.g.nodes.length, sl.w - 2, sl.h - 1)
    fits = fits && g.fits
    sl.g.nodes.forEach((nd, i) => pos.set(nd.id, { x: sl.x + 1 + (i % g.per) * g.sx, y: sl.y + 1 + Math.floor(i / g.per) * g.sy }))
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
    const hit = out.find(g => !s.quote && !g[0].quote && rowsOf(g[0].ref) === rowsOf(s.ref))
    if (hit) hit.push(s)
    else out.push([s])
  }
  return out.slice(0, MAX_EVIDENCE)
}

const fmtVal = v => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : String(+v.toPrecision(4))) : v == null ? '' : String(v))
/** The query a ref cites a value of (`r2` of `r2#group=male@n`), or null for a row of a file. */
const queryOf = ref => (/^([qr]\d+)(?:#|$)/.exec(String(ref)) || [])[1] || null
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
  if (s0.quote) return `{cite:“${e(one(s0.quote))}”} {dim:${e(shortRef(s0.ref))}}`
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
  const gots = evidence.map(g => (g[0].quote ? null : k.want({ rows: [g[0].ref] })))
  const part = (j, node) => k.region(`ev-${j + 1}`, { label: `evidence: ${evidence[j].map(s => s.label).join(', ')}`, ref: evidence[j][0].ref }, node)
  const done = new Set()
  evidence.forEach((g, i) => {
    if (done.has(i)) return
    const q = g[0].quote ? null : queryOf(g[0].ref)
    const same = q ? evidence.map((_, j) => j).filter(j => !done.has(j) && !evidence[j][0].quote && queryOf(evidence[j][0].ref) === q) : []
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

/** How many rows a claim's evidence takes: one a row, and one more for each query's table. */
export function evidenceHeight(evidence) {
  const qs = new Set(evidence.filter(g => !g[0].quote).map(g => queryOf(g[0].ref)).filter(Boolean))
  return Math.max(1, evidence.length + qs.size)
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
  const other = claim.revised_by ? byId.get(claim.revised_by) : claim.revises ? byId.get(claim.revises) : null
  const rowsHere = new Set(['said', ...evidence.map((_, i) => `ev-${i + 1}`), ...(other ? [`fix-${other.id}`] : [])])
  const at = data.last ?? null
  const pick = id => (byId.has(id) ? { claim: id, part: nodeRegion(id), at } : null)
  const nodeOf = r => claims.find(c => nodeRegion(c.id) === r) || null
  const part = !fresh && st.part && (rowsHere.has(st.part) || st.part === nodeRegion(claim.id)) ? st.part : nodeRegion(claim.id)

  // ---- what the person does
  k.on('focus', e => {
    const n = nodeOf(e.region)
    if (n) return pick(n.id)
    if (rowsHere.has(String(e.region))) return { claim: claim.id, part: String(e.region), at }
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
    if (other && r === `fix-${other.id}`) return pick(other.id)
    if (r === 'folder') { k.do('folder'); return null }
    return null
  })
  const step = dir => () => {
    const i = claims.findIndex(c => c.id === claim.id)
    return pick(claims[(i + dir + claims.length) % claims.length].id)
  }
  k.on('up', step(-1), 'move')
  k.on('down', step(1), 'move')
  // ↵ presses what the ring is on (Claude Code's own press); the bar says what that does there
  const enter = part === `fix-${other?.id}` ? (claim.revised_by ? 'the correction' : 'the claim it corrects') : /^ev-/.test(part) ? 'open the rows' : claim.folder && !(claim.said || []).some(x => x.row) ? 'open the rows' : 'where it was said'
  k.on('return', () => null, enter)
  k.select(part)

  // ---- the claim selected, under the graph: its sentence, its evidence, the claim that corrects it or that it corrects
  const rowsFor = x => 1 + Math.min(MAX_SENTENCE, wrap(`${x.text} · ${saidWords(x)}`, W - 3).length) + evidenceHeight(evidenceOf(x)) + (x.revised_by || x.revises ? 1 : 0)
  const panel = claimRows(k, { claim, tone, evidence, other, W })

  // ---- the graph, in the rows left: the rows under it are those of the tallest claim's, so the graph keeps its size and
  // its dots their places while the ring walks them. A conversation under the pane takes about two fifths of the rows,
  // the input bar four
  const all = k.h || 40
  const H = Math.max(12, all - 4 - (data.talk ? Math.floor(all * 0.4) : 0))
  const tallest = Math.max(...claims.map(rowsFor))
  const named = groups.map(g => ({ id: g.id, name: g.folder ? `${g.name} (folder)` : g.name }))
  const order = claims.slice().sort((p, q) => (p.folder ? 1 : 0) - (q.folder ? 1 : 0) || (p.turn ?? 0) - (q.turn ?? 0) || num(p) - num(q))
  const nodes = order.map(c => ({ id: c.id, cluster: c.cluster }))
  const room = Math.max(6, H - head.length - 1 - Math.max(tallest, panel.length))
  // as many rows as the room has; a graph that does not fit even its dense spacing there takes more rows, and the side
  // panel shows the rows around the dot selected
  let lay = trim(layout(nodes, named, { w: W, h: room }))
  for (let h = room + 4; !lay.fits && h <= room + 200; h += 4) lay = trim(layout(nodes, named, { w: W, h }))
  const c = k.canvas(W, lay.h)
  for (const nm of lay.names) {
    const gg = groups.find(x => String(x.id) === nm.id)
    c.text(nm.x, nm.y, `{${toneOf(gg ? gg.i : 0)}:${k.escape(nm.name)}}`)
  }
  // the claims linked to the one selected stand out on a tinted ground: amber for the correction, gray for the same
  // rows, red for a contradiction, blue for any other link. No line is drawn: in rows of dots a line runs through the
  // dots between its ends, and a hundred claims would hide under them
  const edges = data.edges || []
  const near = new Map()
  for (const e of edges) {
    if (e.a !== claim.id && e.b !== claim.id) continue
    const id = e.a === claim.id ? e.b : e.a
    // a correction outranks any other link between the same two claims
    if (!near.has(id) || e.kind === 'corrects') near.set(id, edgeTone(e))
  }
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (!p) continue
    c.dot(p.x, p.y, tone(x), { glyph: dotOf(x), bold: x.id === claim.id || near.has(x.id), part: nodeRegion(x.id), meta: { label: `claim: ${x.text}`, ref: (x.sources || []).map(s => s.ref).slice(0, 6) } })
    if (near.has(x.id)) c.bg(p.x - 1, p.y, 3, 1, `${near.get(x.id)}-faint`)
  }
  return k.stack(...head, k.text(' '), c, ...panel)
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

/** The claim selected, as rows under the graph: its sentence (a press opens where it was said), each row of its
 *  evidence (a press opens it), and the claim it corrects or that corrects it (a press selects it). */
function claimRows(k, { claim, tone, evidence, other, W }) {
  const e = k.escape
  const rows = [k.text(' ')]
  const who = saidWords(claim)
  const sentence = k.beside(
    k.text(`{${tone(claim)}:${dotOf(claim)}}`, { wrap: false, w: 1 }),
    k.text(`**${e(sentenceOf(claim.text))}**${who ? ` {dim:· ${e(who)}}` : ''}`, { max: MAX_SENTENCE }),
    { gap: 1 },
  )
  rows.push(k.region('said', { label: `where "${cut(claim.text, 60)}" was said`, ref: (claim.sources || []).map(x => x.ref).slice(0, 6) }, sentence))
  // its evidence: what each row it cites holds, the cited values marked
  if (!evidence.length) rows.push(k.text('  {dim:cites no rows}', { wrap: false }))
  rows.push(...evidenceRows(k, evidence))
  if (other) {
    const how = claim.revised_by ? 'corrected by' : 'corrects'
    rows.push(k.region(`fix-${other.id}`, { label: `claim: ${other.text}`, ref: (other.sources || []).map(x => x.ref).slice(0, 6) },
      k.text(`  {warn:${how}} {${tone(other)}:${dotOf(other)}} ${e(sentenceOf(other.text))}${other.by === 'person' ? ' {dim:· you said this}' : ''}`, { wrap: false })))
  }
  return rows
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
