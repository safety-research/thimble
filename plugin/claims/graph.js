// graph.js: the Claims pane, a program on the card runtime (draw/kit.js) over the session's claims (store.js). It opens
// in the side panel (claims/term.ts openSide) and is one view: the graph.
//
//   the graph       each claim a dot, the claims of a cluster an island in the cluster's color with its name over it;
//                   a hollow dot is a claim a later one corrected, a heavier one a claim said twice or more. A dashed
//                   line joins a correction to the claim it corrects, a thin one two claims that cite the same rows.
//   the claim       under the graph, the claim selected: its words, its turn, where it came from (a press, or ↵ on
//                   its dot, opens the place in the transcript over the pane, as a citation opens), the claim that
//                   corrects it or that it corrects, and its evidence (each citation with what its rows say; its
//                   digit opens it over the pane)
//   where it came from   the same module with args {source}: the message that said the claim, its words marked, and
//                   the other places it was said
//
// The side panel holds the keys: the ring (↑↓) walks the dots and the claim's rows and selects what it lands on
// (k.select), and the panel's input bar asks its thread about that.
//
//   state: {claim, part: the dot or row selected}
//   reads: claims (the store with the folder's offer), threads (whether the panel's thread has a conversation, which
//          takes rows under the pane); with {source, row}: claims and the message's record
//   wants: {rows: [ref]} for each evidence row of the selected claim (what its rows say, through the kernel)
//   asks of the host: open {mark} (a citation, over the pane), source {id, row} (where a claim came from, over the
//   pane), folder (asks Claude to map the folder's claims: a press on its row, never a key, since it starts a turn)
import { chainWords } from '../shell/object.js'
import { blocks } from '../shell/message.js'
import { threadKey } from '../shell/threads.js'
import { edgesOf, findQuote, plainOf, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const MAX_EVIDENCE = 4

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

/** Who said a claim and when, in a few words: `turn 2`, `turn 2 · you`, `the folder`. */
export function whenOf(c) {
  if (c.by === 'folder') return 'the folder'
  return [c.turn != null ? `turn ${c.turn}` : '', c.by === 'person' ? 'you' : ''].filter(Boolean).join(' · ')
}

const hash = s => {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

/**
 * The graph laid out in cells, w × h: each cluster an island around an anchor (the anchors on an ellipse that fills
 * the area), its claims pushed apart and pulled together along their edges, then snapped to cells so no two dots
 * touch; each cluster's name over its island (else under it), where it crosses no dot and no other name. A cell is
 * about twice as tall as wide, so heights count double. Deterministic for the same input. {pos: Map(id -> {x, y}),
 * names: [{id, name, x, y}]}
 */
export function layout(nodes, clusters, edges, { w, h }) {
  const W = Math.max(20, w)
  const H = Math.max(6, h)
  const used = clusters.filter(c => nodes.some(n => String(n.cluster) === String(c.id)))
  const m = Math.max(1, used.length)
  const cx = W / 2, cy = H, rx = W * 0.34, ry = H * 0.62
  const anchor = new Map()
  used.forEach((c, i) => {
    const a = -Math.PI / 2 + (i / m) * Math.PI * 2 + (m % 2 ? 0 : Math.PI / m)
    anchor.set(String(c.id), m === 1 ? [cx, cy] : [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
  })
  const P = nodes.map(n => {
    const [ax, ay] = anchor.get(String(n.cluster)) || [cx, cy]
    return { id: n.id, cluster: String(n.cluster), x: ax + (hash(n.id) - 0.5) * 10, y: ay + (hash(n.id + '#') - 0.5) * 6, vx: 0, vy: 0 }
  })
  const at = new Map(P.map((p, i) => [p.id, i]))
  const springs = edges.map(e => [at.get(e.a), at.get(e.b)]).filter(([i, j]) => i != null && j != null && P[i].cluster === P[j].cluster)
  for (let it = 0; it < 240; it++) {
    const a = 1 - it / 280
    for (let i = 0; i < P.length; i++) {
      const p = P[i]
      for (let j = i + 1; j < P.length; j++) {
        const q = P[j]
        let dx = q.x - p.x, dy = q.y - p.y
        let d2 = dx * dx + dy * dy
        const same = p.cluster === q.cluster
        if (d2 > (same ? 64 : 196)) continue
        if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02 }
        const f = ((same ? 7 : 14) * a) / d2
        p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f
      }
      const [ax, ay] = anchor.get(p.cluster) || [cx, cy]
      p.vx += (ax - p.x) * 0.05 * a
      p.vy += (ay - p.y) * 0.05 * a
    }
    for (const [i, j] of springs) {
      const p = P[i], q = P[j]
      const dx = q.x - p.x, dy = q.y - p.y
      const d = Math.max(0.1, Math.hypot(dx, dy))
      const f = ((d - 4) * 0.2 * a) / d
      p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f
    }
    for (const p of P) {
      p.vx *= 0.6; p.vy *= 0.6
      p.x = Math.max(2, Math.min(W - 3, p.x + Math.max(-3, Math.min(3, p.vx))))
      p.y = Math.max(2, Math.min(2 * H - 3, p.y + Math.max(-3, Math.min(3, p.vy))))
    }
  }
  // snapped to cells, in the order given: no two dots on one row within 3 cells, nor in the rows above and below
  const pos = new Map()
  const taken = []
  const free = (x, y) => x >= 1 && x <= W - 2 && y >= 1 && y <= H - 1 && !taken.some(t => (t.y === y && Math.abs(t.x - x) < 4) || (Math.abs(t.y - y) === 1 && Math.abs(t.x - x) < 2))
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
    got = got || { x: Math.max(1, Math.min(W - 2, x0)), y: Math.max(1, Math.min(H - 1, y0)) }
    taken.push(got)
    pos.set(p.id, got)
  }
  // each cluster's name over its island, else under it, else beside its middle
  const names = []
  for (const c of used) {
    const mine = nodes.filter(n => String(n.cluster) === String(c.id)).map(n => pos.get(n.id))
    const mx = mine.reduce((s, p) => s + p.x, 0) / mine.length
    const top = Math.min(...mine.map(p => p.y)), bottom = Math.max(...mine.map(p => p.y))
    const name = cut(String(c.name), Math.max(8, Math.floor(W / 2)))
    const len = Array.from(name).length
    const x = Math.max(0, Math.min(W - len, Math.round(mx - len / 2)))
    const clear = y => y >= 0 && y <= H - 1 && ![...pos.values()].some(p => p.y === y && p.x >= x - 1 && p.x <= x + len) &&
      !names.some(o => o.y === y && x < o.x + Array.from(o.name).length + 2 && o.x < x + len + 2)
    const y = [top - 1, top - 2, bottom + 1, bottom + 2, Math.round((top + bottom) / 2)].find(clear)
    if (y != null) names.push({ id: String(c.id), name, x, y })
  }
  return { pos, names }
}

const slim = c => ({
  id: c.id, text: c.text, by: c.by, cluster: c.cluster ?? null, turn: c.turn ?? null, n: c.n || 1,
  ...(c.revised_by ? { revised_by: c.revised_by } : {}), ...(c.revises ? { revises: c.revises } : {}),
  ...(c.folder ? { folder: true } : {}),
  sources: (c.sources || []).slice(0, 8).map(s => ({ ref: s.ref, label: s.label || s.ref, ...(s.quote ? { quote: s.quote } : {}) })),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row ?? null, by: s.by, turn: s.turn ?? null, quote: s.quote || '', sentence: s.sentence || '', ...(s.start != null ? { start: s.start, end: s.end } : {}), ...(s.ref ? { ref: s.ref } : {}) })),
})

export default {
  name: 'claims',
  title: 'Claims',
  titleOf: args => (args && args.source ? 'Where it came from' : 'Claims'),
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
      return { about: c ? `where the claim "${cut(c.text, 200)}" was said (${whenOf(c) || 'this session'})` : 'where a claim was said' }
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

  // ---- the head: "Claims  14 claims · 4 clusters · to turn 3"
  const head = []
  const counts = `${data.total} claim${data.total === 1 ? '' : 's'} · ${data.clusters} cluster${data.clusters === 1 ? '' : 's'}${data.last != null ? ` · to turn ${data.last}` : ''}`
  head.push(k.text(`{c2:**Claims**}  {dim:${k.escape(counts)}}`, { wrap: false }))
  for (const g of data.gaps || []) head.push(k.text(`{bad:Turn ${g.turn} was not read:} {dim:${k.escape(cut(g.why || 'the check of the answer failed', W - 24))}}`, { wrap: false }))
  const folderLine = folderWords(k, data)
  if (folderLine) head.push(folderLine)
  if (!claims.length) {
    head.push(k.text(' '))
    head.push(k.text('{dim:No claims yet. After each turn of work, the statements Claude and you made come here, as a graph.}'))
    return k.stack(head)
  }

  // ---- what is selected: the claim the state names, else the newest (of the last turn, the last said)
  const num = c => Number(/\d+$/.exec(String(c.id))?.[0] || 0)
  const newest = claims.reduce((b, c) => ((c.turn ?? -1) > (b.turn ?? -1) || ((c.turn ?? -1) === (b.turn ?? -1) && num(c) > num(b)) ? c : b))
  const claim = byId.get(st.claim) || newest
  const evidence = (claim.sources || []).slice(0, MAX_EVIDENCE)
  const other = claim.revised_by ? byId.get(claim.revised_by) : claim.revises ? byId.get(claim.revises) : null
  const rowsHere = new Set(['said', ...evidence.map((_, i) => `ev-${i + 1}`), ...(other ? [`fix-${other.id}`] : [])])
  const pick = id => (byId.has(id) ? { claim: id, part: nodeRegion(id) } : null)
  const nodeOf = r => claims.find(c => nodeRegion(c.id) === r) || null

  // ---- what the person does
  k.on('focus', e => {
    const n = nodeOf(e.region)
    if (n) return pick(n.id)
    if (rowsHere.has(String(e.region))) return { claim: claim.id, part: String(e.region) }
    return null
  })
  const openSource = c => {
    const said = (c.said || []).find(x => x.by !== 'folder' && x.row)
    // a claim of the folder's map came from its first evidence row: that opens as a citation does
    if (!said && c.sources && c.sources[0]) { k.do('open', { mark: { kind: 'cite', ref: c.sources[0].ref, label: c.sources[0].quote || c.sources[0].label } }); return }
    if (said) k.do('source', { id: c.id, row: said.row })
  }
  const openEvidence = s => { if (s) k.do('open', { mark: { kind: 'cite', ref: s.ref, label: s.label || s.ref } }) }
  k.on('press', e => {
    const r = String(e.region || '')
    const n = nodeOf(r)
    // a press on the dot selected opens where it came from; on another dot it selects that one
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
  // ↵ presses what the ring is on (Claude Code's own press): on the dot selected, where it came from
  k.on('return', () => null, 'open')
  evidence.forEach((s, i) => k.on(String(i + 1), () => { openEvidence(s); return null }, 'evidence'))

  const part = st.part && (rowsHere.has(st.part) || st.part === nodeRegion(claim.id)) ? st.part : nodeRegion(claim.id)
  k.select(part)

  // ---- the claim selected, under the graph
  const panel = []
  const add = (markup, region, meta) => panel.push(region ? k.region(region, meta, k.text(markup, { wrap: false })) : k.text(markup, { wrap: false }))
  panel.push(k.text(' '))
  wrap(claim.text, W - 2).slice(0, 3).forEach((l, i) => add(`${i ? '  ' : `{${tone(claim)}:${dotOf(claim)}} `}**${k.escape(l)}**`))
  const g = groups.find(x => String(x.id) === String(claim.cluster))
  const meta = [g ? g.name : '', whenOf(claim), (claim.n || 1) >= 2 ? `said ${claim.n} times` : ''].filter(Boolean)
  add(`  {dim:${k.escape(meta.join(' · '))}}`)
  const said = (claim.said || []).find(x => x.sentence || x.quote)
  if (said || (claim.folder && evidence.length)) {
    const words = said ? (said.sentence || said.quote) : evidence[0].quote || evidence[0].label
    add(`  {dim:from} {cite:“${k.escape(cut(words, W - 12))}”}`, 'said', { label: `where "${cut(claim.text, 60)}" was said`, ref: (claim.sources || []).map(x => x.ref).slice(0, 6) })
  }
  if (other) {
    const how = claim.revised_by ? `corrected in ${whenOf(other) || 'a later turn'} by` : 'corrects'
    add(`  {warn:${k.escape(how)}} ${k.escape(cut(other.text, W - how.length - 6))}`, `fix-${other.id}`, { label: `claim: ${other.text}`, ref: (other.sources || []).map(x => x.ref).slice(0, 6) })
  }
  evidence.forEach((s, i) => {
    const got = k.want({ rows: [s.ref] })
    const words = got ? chainWords(got) : null
    const gist = !got ? 'reading its rows…' : words.error ? `does not resolve: ${words.notes[0] || ''}` : words.line
    const lw = Math.min(14, Math.max(4, Array.from(String(s.label)).length + 1))
    add(`  {accent:${i + 1}} {cite:${k.escape(cut(s.label, lw))}}${' '.repeat(Math.max(1, lw - Array.from(cut(s.label, lw)).length + 1))}{dim:${k.escape(cut(gist, W - lw - 7))}}`, `ev-${i + 1}`, { label: `evidence: ${s.label}`, ref: s.ref })
  })

  // ---- the graph, in the rows left: the side panel's input bar takes its rows under the pane, and a conversation
  // about two fifths of the rest
  const all = k.h || 40
  const H = Math.max(12, all - 4 - (data.talk ? Math.floor(all * 0.4) : 0))
  const legend = k.text('{dim:○ corrected · ◉ said again · ╌ a correction · ─ cite the same rows}', { wrap: false })
  // as tall as the graph needs (about two rows a claim, and room for each cluster's name), at most the rows left
  const need = 4 + Math.ceil(claims.length * 0.8) + 2 * groups.length
  const gh = Math.max(6, Math.min(need, H - head.length - panel.length - 3))
  const edges = data.edges || []
  const named = groups.map(g => ({ id: g.id, name: g.folder ? `${g.name} (folder)` : g.name }))
  const lay = trim(layout(claims.map(c => ({ id: c.id, cluster: c.cluster })), named, edges, { w: W, h: gh }))
  const c = k.canvas(W, lay.h)
  for (const nm of lay.names) {
    const gg = groups.find(x => String(x.id) === nm.id)
    // no-break spaces, so a line drawn after it never runs through a name
    c.text(nm.x, nm.y, `{${toneOf(gg ? gg.i : 0)}:${k.escape(nm.name).replace(/ /g, '\u00a0')}}`)
  }
  for (const x of claims) {
    const p = lay.pos.get(x.id)
    if (!p) continue
    c.dot(p.x, p.y, tone(x), { glyph: dotOf(x), bold: x.id === claim.id, part: nodeRegion(x.id), meta: { label: `claim: ${x.text}`, ref: (x.sources || []).map(s => s.ref).slice(0, 6) } })
  }
  // the edges on the cells left blank: the selected claim's first and bright; of the rest, faint, each correction and
  // the claims of one cluster that cite the same rows (between clusters only the selected claim's, which keeps a large
  // graph readable)
  const mine = e => e.a === claim.id || e.b === claim.id
  const near = e => e.kind === 'corrects' || String(byId.get(e.a)?.cluster) === String(byId.get(e.b)?.cluster)
  for (const e of [...edges.filter(mine), ...edges.filter(e => !mine(e) && near(e))]) {
    const a = lay.pos.get(e.a), b = lay.pos.get(e.b)
    if (!a || !b) continue
    const t = e.kind === 'corrects' ? 'warn' : mine(e) ? 'accent' : 'dim'
    c.link(a.x, a.y, b.x, b.y, mine(e) ? t : `${t}-faint`, { dash: e.kind === 'corrects' })
  }
  return k.stack(...head, k.text(' '), c, legend, ...panel)
}

/** The layout moved up to its first row used (a dot or a name), its height the rows it uses. */
function trim(lay) {
  const ys = [...[...lay.pos.values()].map(p => p.y), ...lay.names.map(n => n.y)]
  const top = ys.length ? Math.min(...ys) : 0
  const h = ys.length ? Math.max(...ys) - top + 1 : 1
  const pos = new Map([...lay.pos].map(([id, p]) => [id, { x: p.x, y: p.y - top }]))
  return { pos, names: lay.names.map(n => ({ ...n, y: n.y - top })), h }
}

/** Where a claim came from: the message that said it as the person reads it, the claim's words marked, and the other
 *  places it was said. */
function sourceView(k, data) {
  const W = Math.max(40, k.w)
  const c = data.source
  if (!c) return k.text('{dim:That claim is not in this session any more.}')
  const said = (c.said || []).filter(x => x.by !== 'folder')
  const first = said[0] || null
  const who = first ? [first.turn != null ? `turn ${first.turn}` : '', first.by === 'person' ? 'your message' : "Claude's message"].filter(Boolean).join(' · ') : ''
  const lines = [k.text(`{c2:**Where it came from**}  {dim:${k.escape(who)}}`, { wrap: false }), k.text(' ')]
  const meta = { label: `where "${cut(c.text, 60)}" was said`, ref: (c.sources || []).map(x => x.ref).slice(0, 6) }
  const seg = r => k.text(r.map(x => (x.on ? `{accent:**${k.escape(x.s)}**}` : k.escape(x.s))).join(''), { wrap: false })
  const msg = first && data.text ? messageRows(data.text, first, W - 1) : null
  if (msg) {
    msg.rows.slice(0, msg.at).forEach(r => lines.push(seg(r)))
    lines.push(k.region('quote', meta, k.stack(msg.rows.slice(msg.at, msg.last + 1).map(seg))))
    msg.rows.slice(msg.last + 1).forEach(r => lines.push(seg(r)))
  } else if (first) {
    lines.push(k.region('quote', meta, k.text(`{accent:**“${k.escape(cut(first.sentence || first.quote, W - 4))}”**}`, { wrap: false })))
  }
  k.select('quote')
  const again = said.slice(1)
  if (again.length) {
    lines.push(k.text(' '))
    lines.push(k.text(`{dim:said again ${again.length === 1 ? 'once' : `${again.length} times`}}`))
    for (const p of again) lines.push(k.text(`{dim:${k.escape([p.turn != null ? `turn ${p.turn}` : '', p.by === 'person' ? 'you' : ''].filter(Boolean).join(' · '))}}  “${k.escape(cut(p.sentence || p.quote, W - 16))}”`, { wrap: false }))
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

/** The folder's line under the head: its map (how much it read), Claude making it, or the offer to make one. */
function folderWords(k, data) {
  const f = data.folder
  if (f) {
    const what = f.scope && f.scope.n != null ? `${f.scope.n} ${f.scope.unit || 'files'}` : 'the folder'
    return k.text(`{dim:the folder's map: ${f.claims} claim${f.claims === 1 ? '' : 's'} in ${f.clusters} cluster${f.clusters === 1 ? '' : 's'}, from ${k.escape(what)}}`, { wrap: false })
  }
  if (data.asked) return k.text('{warn:Claude is mapping the folder\'s claims;} {dim:they join these when it saves the map}', { wrap: false })
  if (data.offer) return k.region('folder', { label: `map the claims of the whole folder: ${data.offer.what}` }, k.text(`{accent:map the claims of the whole folder} {dim:· ${k.escape(data.offer.what)} · about ${data.offer.minutes} min, read by a subagent}`, { wrap: false }))
  return null
}
