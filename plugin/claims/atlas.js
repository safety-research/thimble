// atlas.js: the Claims pane, a program on the card runtime (draw/kit.js) over the session's claims (store.js). It opens
// in the side panel, where the card detail opens (claims/term.ts openSide), and shows the claims as the atlas did,
// fitted to cells:
//
//   the map      one row per cluster: its name, a dot per claim in the color of its kind (fact, finding, judgment
//                call, event, claim), how many, and its lead claim. At its left an arc joins two clusters whose claims
//                bear on each other (a correction, a relation of the folder's map, a row both cite); the arcs of the
//                selected cluster are bright, a correction's in amber.
//   the cluster  the selected cluster's claims, one row each; a corrected claim is a hollow dot, one said twice or more
//                a heavier one. The selected claim is open under its row: what it means (precisely, judgment, not
//                stated, based on), where it was said, its evidence rows (each citation with what its rows say; a
//                press or its digit opens it as a citation opens, over the pane) and the claims it bears on (a press
//                goes there)
//
// The side panel holds the keys: the ring (↑↓) walks the rows and selects what it lands on (k.select), a cluster, a
// claim or one of the claim's rows (↵ on a cluster goes into its claims), and the panel's thread asks about that row,
// with its refs. So a question with the
// ring on a claim is about the claim and its citations, and one on an evidence row about that evidence.
//
//   state: {cluster, claim, part: the row selected}
//   reads: claims (the store with the folder's offer), threads (whether the panel's thread has a conversation, which
//          takes rows under the pane)
//   wants: {rows: [ref]} for each evidence row of the selected claim (what its rows say, through the kernel)
//   asks of the host: open {mark} (a citation, over the pane), said {row} (the message where it was said), folder
//   (asks Claude to map the folder's claims: a press on its row, never a key, since it starts a turn)
import { chainWords } from '../shell/object.js'
import { threadKey } from '../shell/threads.js'
import { KINDS, clusterLinks, kindName, kindRank, kindTone, laneLinks, related, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const LABEL = 12
const MAX_EVIDENCE = 4
const MAX_RELATED = 4

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

export const clusterRegion = id => `cl-${id == null ? 'none' : String(id).replace(/[^A-Za-z0-9_.:-]/g, '-')}`
export const claimRegion = id => `c-${String(id).replace(/[^A-Za-z0-9_.:-]/g, '-')}`

/** The dot of a claim: hollow once corrected, heavier when said twice or more. */
export const dotOf = c => (c.revised_by ? '○' : (c.n || 1) >= 2 ? '◉' : '●')

/** Who said a claim and when, in a few words: `turn 2`, `turn 2 · you`, `the folder`. */
export function whenOf(c) {
  if (c.by === 'folder') return 'the folder'
  return [c.turn != null ? `turn ${c.turn}` : '', c.by === 'person' ? 'you' : ''].filter(Boolean).join(' · ')
}

const slim = c => ({
  id: c.id, text: c.text, kind: c.kind, by: c.by, cluster: c.cluster ?? null, turn: c.turn ?? null, n: c.n || 1,
  ...(c.revised_by ? { revised_by: c.revised_by } : {}), ...(c.revises ? { revises: c.revises } : {}),
  ...(c.precisely ? { precisely: c.precisely } : {}), ...(c.based_on ? { based_on: c.based_on } : {}),
  ...(c.judgment ? { judgment: c.judgment } : {}), ...(c.unstated ? { unstated: c.unstated } : {}),
  ...(c.links && c.links.length ? { links: c.links } : {}), ...(c.folder ? { folder: true } : {}),
  ...(typeof c.n_of === 'number' ? { n_of: c.n_of } : {}), ...(typeof c.of === 'number' ? { of: c.of } : {}),
  sources: (c.sources || []).slice(0, 8).map(s => ({ ref: s.ref, label: s.label || s.ref, ...(s.quote ? { quote: s.quote } : {}) })),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row ?? null, by: s.by, turn: s.turn ?? null, quote: s.quote || '', sentence: s.sentence || '', ...(s.start != null ? { start: s.start } : {}) })),
})

export default {
  name: 'claims',
  title: 'Claims',
  reads: () => ['claims', 'threads'],
  stateKey: () => 'claims',
  data(stores) {
    const store = stores.claims && Array.isArray(stores.claims.claims) ? stores.claims : { claims: [], clusters: [], gaps: [] }
    const view = viewOf({ clusters: [], gaps: [], ...store })
    const groups = view.groups.map(g => ({ id: g.id ?? null, name: g.name, folder: g.from === 'folder', claims: g.claims.map(c => c.id) }))
    // the panel's thread (one per pane: shell/side.ts) and whether it has a conversation, which takes rows under the pane
    const key = threadKey({ pane: 'claims', key: 'claims' })
    const talk = (Array.isArray(stores.threads) ? stores.threads : []).some(t => t && t.key === key && (t.turns || []).length)
    const kinds = {}
    for (const c of view.flat) kinds[c.kind] = (kinds[c.kind] || 0) + 1
    return {
      talk, total: view.total, clusters: view.clusters, last: view.last, gaps: (view.gaps || []).slice(-3),
      claims: view.flat.map(slim), groups, links: clusterLinks(view), kinds,
      offer: store.offer || null, folder: store.folder || null, asked: store.folderAsked || null,
    }
  },
  // what the panel's thread is about, beside the row selected (shell/side.ts): the claim open in the pane. Text a
  // model reads (the thread's agent), logged with the prompts
  thread(args, state, data) {
    const c = ((data && data.claims) || []).find(x => x.id === (state && state.claim))
    if (!c) return { about: 'the claims of this session, in clusters' }
    const said = (c.said || []).find(x => x.sentence || x.quote)
    return { about: `the claims of this session, in clusters; the claim open in it is "${cut(c.text, 200)}" (${kindName(c.kind)}, ${whenOf(c) || 'this session'}${said ? `, said as "${cut(said.sentence || said.quote, 240)}"` : ''})` }
  },
  program,
}

export function program(k, data) {
  const st = k.state || {}
  const W = Math.max(40, k.w)
  const claims = data.claims || []
  const byId = new Map(claims.map(c => [c.id, c]))
  const groups = data.groups || []
  const groupOf = id => groups.find(g => String(g.id) === String(id)) || null

  // ---- what is selected: the claim the state names, else the selected cluster's lead, else the newest claim
  const leadOf = g => {
    const list = (g?.claims || []).map(id => byId.get(id)).filter(Boolean)
    const live = list.filter(c => !c.revised_by)
    return (live.length ? live : list).slice().sort((a, b) => (b.n || 1) - (a.n || 1) || (b.turn ?? 0) - (a.turn ?? 0))[0] || null
  }
  const newest = claims.slice().sort((a, b) => (b.turn ?? -1) - (a.turn ?? -1))[0] || null
  let claim = byId.get(st.claim) || null
  let group = (st.cluster !== undefined && groupOf(st.cluster)) || (claim ? groupOf(claim.cluster) : null)
  if (!group && newest) group = groupOf(newest.cluster)
  if (!group) group = groups[0] || null
  if (!claim || String(claim.cluster) !== String(group?.id)) claim = leadOf(group)
  const rel = claim ? related(claims, claim.id, MAX_RELATED) : []
  const evidence = claim ? (claim.sources || []).slice(0, MAX_EVIDENCE) : []

  // ---- what the person does: each a new selection, the row selected among them (`part`)
  const pickCluster = id => {
    const g = groupOf(id)
    return g ? { cluster: g.id, claim: leadOf(g)?.id ?? null, part: clusterRegion(g.id) } : null
  }
  const pickClaim = id => {
    const c = byId.get(id)
    return c ? { cluster: c.cluster ?? null, claim: c.id, part: claimRegion(c.id) } : null
  }
  const regionOf = r => {
    const s = String(r || '')
    const g = groups.find(x => clusterRegion(x.id) === s)
    if (g) return { cluster: g }
    const c = claims.find(x => claimRegion(x.id) === s || `rel-${x.id}` === s)
    if (c) return { claim: c, related: s.startsWith('rel-') }
    const ev = /^ev-(\d+)$/.exec(s)
    if (ev) return { evidence: evidence[Number(ev[1]) - 1] || null }
    return { other: s }
  }
  // the ring on a cluster or a claim selects it; on one of the open claim's rows it selects that row, the claim kept
  const rowsHere = new Set(['said', ...evidence.map((_, i) => `ev-${i + 1}`), ...rel.map(r => `rel-${r.id}`)])
  k.on('focus', e => {
    const r = regionOf(e.region)
    if (r.cluster) return pickCluster(r.cluster.id)
    if (r.claim && !r.related) return pickClaim(r.claim.id)
    if (rowsHere.has(String(e.region))) return { cluster: group?.id ?? null, claim: claim?.id ?? null, part: String(e.region) }
    return null
  })
  const openEvidence = s => { if (s) k.do('open', { mark: { kind: 'cite', ref: s.ref, label: s.label || s.ref } }) }
  k.on('press', e => {
    const r = regionOf(e.region)
    // ↵ (or a click) on a cluster goes into it: its lead claim selected, open under its row, the ring there
    if (r.cluster) { const p = pickCluster(r.cluster.id); return p && p.claim ? { ...p, part: claimRegion(p.claim) } : p }
    // a claim, or a claim the open one bears on: it is selected, open under its row
    if (r.claim) return pickClaim(r.claim.id)
    if (r.evidence) { openEvidence(r.evidence); return null }
    if (r.other === 'said' && claim?.said?.[0]?.row) { k.do('said', { row: claim.said[0].row }); return null }
    if (r.other === 'folder') { k.do('folder'); return null }
    return null
  })
  // the arrows move between the rows (Claude Code moves the ring; a surface that sends them steps through the claims)
  const step = dir => () => {
    if (!claims.length) return null
    const i = claim ? claims.findIndex(c => c.id === claim.id) : -1
    return pickClaim(claims[(i + dir + claims.length) % claims.length].id)
  }
  k.on('up', step(-1), 'move')
  k.on('down', step(1), 'move')
  // ↵ presses the row the ring is on (Claude Code's own press); named here so the bar says it
  k.on('return', () => null, 'open')
  evidence.forEach((s, i) => k.on(String(i + 1), () => { openEvidence(s); return null }, 'evidence'))

  // ---- the head: "Claims  14 claims · 4 clusters · turn 3", and the kinds present with how many
  const lines = []
  const counts = `${data.total} claim${data.total === 1 ? '' : 's'} · ${data.clusters} cluster${data.clusters === 1 ? '' : 's'}${data.last != null ? ` · to turn ${data.last}` : ''}`
  lines.push(k.text(`{c2:**Claims**}  {dim:${k.escape(counts)}}`, { wrap: false }))
  const extra = []
  const kinds = KINDS.filter(x => data.kinds && data.kinds[x.id])
  if (kinds.length) extra.push(k.text(kinds.map(x => `{${x.tone}:●} {dim:${x.name} ${data.kinds[x.id]}}`).join('   '), { wrap: false }))
  for (const g of data.gaps || []) extra.push(k.text(`{bad:Turn ${g.turn} was not read:} {dim:${k.escape(cut(g.why || 'the check of the answer failed', W - 24))}}`, { wrap: false }))
  // the folder: its map, the offer to make one, or that Claude is making it
  const folderLine = folderWords(k, data)
  if (folderLine) extra.push(folderLine)

  if (!claims.length) {
    lines.push(...extra, k.text(' '))
    lines.push(k.text('{dim:No claims yet. After each turn of work, the claims Claude and you made come here, in clusters.}'))
    return k.stack(lines)
  }
  extra.push(k.text(' '))

  // ---- the map: one row per cluster, the arcs of their links at its left
  const rowOf = new Map(groups.map((g, i) => [String(g.id), i]))
  const touches = l => String(l.a) === String(group?.id) || String(l.b) === String(group?.id)
  let { links, lanes } = laneLinks(data.links || [], id => rowOf.get(String(id)))
  // many links (a folder's map beside the session's): the selected cluster's alone, so the map stays readable
  if (lanes > 6) ({ links, lanes } = laneLinks((data.links || []).filter(touches), id => rowOf.get(String(id))))
  const P = lanes ? lanes + 1 : 0
  const arcs = arcRows(groups.length, links, P, touches)
  const mapRows = []
  const nameW = Math.min(26, Math.max(12, ...groups.map(g => Array.from(String(g.name)).length + (g.folder ? 9 : 0) + 2)))
  const dotsW = Math.min(16, Math.max(4, ...groups.map(g => g.claims.length + 1)))
  groups.forEach((g, i) => {
    const on = String(g.id) === String(group?.id)
    const list = g.claims.map(id => byId.get(id)).filter(Boolean).sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
    const shown = list.slice(0, dotsW - (list.length > dotsW ? 2 : 0))
    const dots = shown.map(c => `{${kindTone(c.kind)}${c.revised_by ? '-faint' : ''}:${dotOf(c)}}`).join('') + (list.length > shown.length ? `{dim:+}` : '')
    const lead = leadOf(g)
    const name = `${on ? '{accent:▸}' : ' '}${on ? `**${k.escape(cut(g.name, nameW - 2))}**` : k.escape(cut(g.name, nameW - 2))}${g.folder ? ' {dim:folder}' : ''}`
    const rest = Math.max(8, W - P - nameW - dotsW - 6)
    const row = k.beside(
      k.text(name, { w: nameW, wrap: false }),
      k.text(dots, { w: dotsW, wrap: false }),
      k.text(`{dim:${list.length}}`, { w: 3, wrap: false, align: 'right' }),
      k.text(lead ? `{dim:${k.escape(cut(lead.text, rest))}}` : '', { wrap: false, grow: 1 }),
      { gap: 1 })
    const region = k.region(clusterRegion(g.id), { label: `cluster: ${g.name}` }, row)
    mapRows.push(P ? k.beside(k.text(arcs[i], { w: P, wrap: false }), region, { gap: 0 }) : region)
  })

  // ---- the selected cluster's claims, the selected one open under its row: what it means, where it was said, its
  // evidence, what it bears on and its thread, so the ring walks from a claim into its own rows and on to the next
  const list = (group?.claims || []).map(id => byId.get(id)).filter(Boolean)
  const mid = [k.text(' ')]
  mid.push(k.text(`{dim:── ${k.escape(cut(group?.name || 'between clusters', W - 30))} · ${list.length} claim${list.length === 1 ? '' : 's'} ${'─'.repeat(Math.max(2, W - Array.from(String(group?.name || '')).length - 22))}}`, { wrap: false }))
  const rows = []
  let cutRow = false
  for (const c of list) {
    const when = whenOf(c)
    const tw = Math.max(10, W - 4 - Math.max(10, when.length + 2))
    if (claim && c.id === claim.id) cutRow = Array.from(c.text).length > tw
    rows.push(k.region(claimRegion(c.id), { label: `claim: ${c.text}`, ref: (c.sources || []).map(s => s.ref).slice(0, 6) },
      k.beside(
        k.text(`{${kindTone(c.kind)}${c.revised_by ? '-faint' : ''}:${dotOf(c)}} ${c.revised_by ? `{dim:${k.escape(cut(c.text, tw))}}` : k.escape(cut(c.text, tw))}`, { wrap: false, grow: 1 }),
        k.text(`{dim:${k.escape(when)}}`, { wrap: false, align: 'right' }),
        { gap: 2 })))
  }
  // the row selected: the one the state names while it is drawn, else the selected claim's
  const part = st.part && (st.part === clusterRegion(group?.id) || st.part === claimRegion(claim?.id) || rowsHere.has(st.part) || (st.part === 'said' && claim)) ? st.part : claim ? claimRegion(claim.id) : null
  if (part) k.select(part)

  const top = lines
  const panel = []
  const thread = []
  if (claim) {
    const I = '  '
    const PW = W - I.length
    const add = (markup, region, meta) => panel.push(region ? k.region(region, meta, k.text(I + markup, { wrap: false })) : k.text(I + markup, { wrap: false }))
    // its words whole, when its row cut them
    if (cutRow) for (const l of wrap(claim.text, PW).slice(0, 3)) add(`**${k.escape(l)}**`)
    const meta = [kindName(claim.kind), whenOf(claim), (claim.n || 1) >= 2 ? `said ${claim.n} times` : '', claim.revised_by ? `corrected by turn ${byId.get(claim.revised_by)?.turn ?? '?'}` : '', typeof claim.n_of === 'number' ? `in ${claim.n_of}${typeof claim.of === 'number' ? ` of ${claim.of}` : ''}` : ''].filter(Boolean)
    add(`{dim:${k.escape(meta.join(' · '))}}`)
    const said = claim.said?.find(s => s.by !== 'folder' && (s.sentence || s.quote))
    if (said) add(`{dim:“${k.escape(cut(said.sentence || said.quote, PW - 2))}”}`, 'said', { label: `where "${cut(claim.text, 60)}" was said`, ref: (claim.sources || []).map(x => x.ref).slice(0, 6) })
    const part = (label, text, tone = 'dim') => {
      const body = wrap(text, PW - LABEL - 1)
      body.slice(0, 2).forEach((l, i) => add(`{${tone}:${(i ? '' : label).padEnd(LABEL)}}${k.escape(i === 1 && body.length > 2 ? cut(l + ' ' + body.slice(2).join(' '), PW - LABEL - 1) : l)}`))
    }
    if (claim.precisely) part('precisely', claim.precisely)
    if (claim.judgment) part('judgment', claim.judgment)
    if (claim.unstated) part('not stated', claim.unstated, 'warn')
    if (claim.based_on && !evidence.length) part('based on', claim.based_on)

    // the evidence: each citation, what its rows say (read through the kernel), and its digit
    if (evidence.length) {
      add('{dim:evidence}')
      evidence.forEach((s, i) => {
        const got = k.want({ rows: [s.ref] })
        const words = got ? chainWords(got) : null
        const gist = !got ? 'reading its rows…' : words.error ? `does not resolve: ${words.notes[0] || ''}` : words.line
        const lw = Math.min(18, Math.max(6, Array.from(String(s.label)).length + 1))
        add(`{accent:${i + 1}} {cite:${k.escape(cut(s.label, lw))}}${' '.repeat(Math.max(1, lw - Array.from(cut(s.label, lw)).length + 1))}{dim:${k.escape(cut(gist, PW - lw - 5))}}`, `ev-${i + 1}`, { label: `evidence: ${s.label}`, ref: s.ref })
        // a row behind it, as the person reads a row: its words, and whose and when it is
        const rec = words && !words.error ? (words.records || [])[0] : null
        const q = s.quote || (rec ? one(rec.words || rec.text) : '')
        const m = !s.quote && rec && rec.meta ? ` · ${one(rec.meta)}` : ''
        if (q) add(`{dim:  ${' '.repeat(lw + 1)}${k.escape(cut(`“${q}”${m}`, PW - lw - 6))}}`)
      })
    }
    if (rel.length) {
      add('{dim:bears on}')
      for (const r of rel) {
        const c = byId.get(r.id)
        if (!c) continue
        add(`{${kindTone(c.kind)}${c.revised_by ? '-faint' : ''}:${dotOf(c)}} {dim:${k.escape(r.why.padEnd(16))}}${k.escape(cut(c.text, PW - 20))}`, `rel-${c.id}`, { label: `claim: ${c.text} (${r.why} "${cut(claim.text, 40)}")`, ref: (c.sources || []).map(x => x.ref).slice(0, 6) })
      }
    }
  }
  return k.stack(fit(k, { top, extra, map: mapRows, mapAt: groups.findIndex(g => String(g.id) === String(group?.id)), mid, rows, at: list.findIndex(c => c.id === claim?.id), panel }, data.talk))
}

/**
 * The pane in the rows it has, never taller (a pane taller than its rows would scroll on ↑↓ instead of moving the
 * ring), and the selected claim's own rows first: the title; the selected claim with its rows open under it (cut at
 * their end); the map as a window around the selected cluster, at most a third of the rows; the legend and the folder's
 * line while they fit; and as many of the cluster's other claims around the selected one as fit. A side cut short says
 * how many more it has. o: {top, extra, map, mapAt, mid, rows, at, panel}.
 */
export function fit(k, o, talk = false) {
  // the side panel's input bar takes its rows under the pane, and a conversation about two fifths of the rest
  const all0 = k.h || 40
  const H = Math.max(12, all0 - 4 - (talk ? Math.floor(all0 * 0.4) : 0))
  const sel = Math.max(0, o.at)
  const open = o.at < 0 ? [] : o.panel
  const whole = [...o.top, ...o.extra, ...o.map, ...o.mid, ...o.rows.slice(0, sel + 1), ...open, ...o.rows.slice(sel + 1)]
  if (whole.length <= H) return whole
  const more = (n, dir) => k.text(`{dim:  ${dir} ${n} more}`)
  // a window of at most n rows of a list around its item `at`, a row saying how many more on each side cut
  const windowOf = (list, at, n) => {
    if (list.length <= n) return list
    const m = Math.max(1, n - 2)
    const from = Math.max(0, Math.min(list.length - m, at - Math.floor(m / 2)))
    return [...(from ? [more(from, '↑')] : []), ...list.slice(from, from + m), ...(from + m < list.length ? [more(list.length - from - m, '↓')] : [])]
  }
  const map = windowOf(o.map, Math.max(0, o.mapAt), Math.max(3, Math.floor(H / 3)))
  let left = H - o.top.length - map.length - o.mid.length - 1
  const p = open.slice(0, Math.max(0, Math.min(open.length, left - 2)))
  left -= p.length
  const extra = o.extra.length <= left - 2 ? o.extra : []
  left -= extra.length
  // the other claims around it, as many above as below
  const aboveAll = sel
  const belowAll = o.rows.length - sel - 1
  const both = aboveAll + belowAll > left
  if (both) left -= 2
  let up = Math.min(aboveAll, Math.ceil(Math.max(0, left) / 2))
  let down = Math.min(belowAll, Math.max(0, left - up))
  up = Math.min(aboveAll, Math.max(0, left - down))
  const out = [...o.top, ...extra, ...map, ...o.mid]
  if (up < aboveAll) out.push(more(aboveAll - up, '↑'))
  out.push(...o.rows.slice(sel - up, sel + 1), ...p, ...o.rows.slice(sel + 1, sel + 1 + down))
  if (down < belowAll) out.push(more(belowAll - down, '↓'))
  return out.slice(0, H)
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

/**
 * The arcs at the map's left, one string of markup per row: each link a vertical line in its lane from its top row to
 * its bottom row, with a stub into each row it joins. `P` columns (the lanes and the stub's column); `bright(link)`:
 * whether it touches the selected cluster.
 */
export function arcRows(n, links, P, bright) {
  if (!P) return Array.from({ length: n }, () => '')
  const grid = Array.from({ length: n }, () => Array.from({ length: P }, () => ({ ch: ' ', tone: null })))
  const toneOf = l => (bright(l) ? (l.corrects ? 'warn' : 'accent') : 'dim')
  const better = (a, b) => (a === 'warn' || a === 'accent' ? a : b || a)
  // the lanes, innermost (lane 0) next to the names
  for (const l of links) {
    const x = P - 2 - l.lane
    const t = toneOf(l)
    for (let y = l.top; y <= l.bottom; y++) {
      const cell = grid[y][x]
      cell.ch = y === l.top ? '╭' : y === l.bottom ? '╰' : '│'
      cell.tone = better(t, cell.tone)
    }
  }
  // the stubs from each lane's end into its row; a stub that crosses another lane joins it
  const CROSS = { '│': '┼', '╭': '┬', '╰': '┴', ' ': '─', '─': '─', '┬': '┬', '┴': '┴', '┼': '┼' }
  for (const l of links) {
    const t = toneOf(l)
    for (const y of [l.top, l.bottom]) {
      for (let x = P - 1 - l.lane; x < P; x++) {
        const cell = grid[y][x]
        cell.ch = CROSS[cell.ch] || '─'
        cell.tone = better(t, cell.tone)
      }
    }
  }
  return grid.map(row => row.map(c => (c.ch === ' ' ? ' ' : `{${c.tone || 'dim'}:${c.ch}}`)).join(''))
}
