// The atlas's drawing program (the body of a function (k, data) => node, on lean's drawing contract).
// Under a reply: one row per cluster with its name, a dot per claim colored by kind, its count and its lead claim.
// A version that added claims from one message shows those claims under that message instead.
// In the detail view: every claim under its cluster, each one a part whose rows are its evidence.
const KINDS = [['fact', 'fact', 'c4'], ['finding', 'finding', 'c1'], ['judgment', 'judgment call', 'c5'], ['event', 'event', 'c3'], ['claim', 'claim', 'c2']]
const TONE = {}
const NAME = {}
const ORDER = {}
KINDS.forEach(([id, name, tone], i) => { TONE[id] = tone; NAME[id] = name; ORDER[id] = i })
const kindOf = c => {
  const s = String((c && c.kind) || 'claim').toLowerCase().trim()
  if (s.startsWith('judg') || s === 'decision') return 'judgment'
  return TONE[s] ? s : 'claim'
}
const esc = s => k.escape(String(s == null ? '' : s))
const refsOf = c => (Array.isArray(c.evidence) ? c.evidence : []).map(e => (typeof e === 'string' ? e : e && e.ref)).filter(x => typeof x === 'string' && x)
const weight = c => (typeof c.n === 'number' ? c.n * 10 : 0) + refsOf(c).length
const slug = s => String(s).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+/, '').slice(0, 56) || 'x'

const claims = (Array.isArray(data.claims) ? data.claims : []).filter(c => c && c.name)
const clusters = (Array.isArray(data.clusters) ? data.clusters : []).filter(c => c && c.id != null)
const groups = clusters.map(c => ({ id: String(c.id), name: String(c.name || c.id), lead: c.lead, claims: [] }))
const byId = {}
groups.forEach(g => { byId[g.id] = g })
const loose = { id: null, name: 'between clusters', claims: [] }
claims.forEach(c => (byId[String(c.cluster)] || loose).claims.push(c))
const shown = groups.filter(g => g.claims.length).concat(loose.claims.length ? [loose] : [])
const scope = data.scope && typeof data.scope === 'object' ? data.scope : {}
const unit = scope.unit || 'files'
const browser = k.state.browser
const bottom = browser === false
  ? 'browser off · the Browser row in /config turns it on, then ↵ opens the graph'
  : '↵ open in browser · esc close'
const head = '{c2:atlas}' + (data.title ? '**{dim: · ' + esc(data.title) + '}**' : '')

function leadOf(g) {
  const named = g.lead != null && g.claims.find(c => String(c.id) === String(g.lead))
  if (named) return named
  return g.claims.slice().sort((a, b) => weight(b) - weight(a))[0]
}
function dotsOf(list, w, spaced) {
  const sorted = list.slice().sort((a, b) => ORDER[kindOf(a)] - ORDER[kindOf(b)])
  const fit = spaced ? sorted.length : Math.min(sorted.length, w)
  const more = sorted.length - fit
  const cut = more > 0 ? sorted.slice(0, Math.max(0, w - String(more).length - 2)) : sorted
  const s = cut.map(c => `{${TONE[kindOf(c)]}:●}`).join(spaced ? ' ' : '')
  return s + (more > 0 ? ` {dim:+${cut.length < sorted.length ? sorted.length - cut.length : more}}` : '')
}
const legend = k.text(KINDS.map(([id, name, tone]) => `{${tone}:●} {dim:${name}}`).join('   '), { wrap: false })

// ------------------------------------------------------------------ a version that added claims from one message
const added = data.added && Array.isArray(data.added.claims) ? data.added.claims.map(String) : []
if (k.mode !== 'detail' && added.length) {
  const fresh = added.map(id => claims.find(c => String(c.id) === id)).filter(Boolean)
  const nameW = Math.max(16, Math.min(60, k.w - 46))
  const rows = fresh.map(c => {
    const g = byId[String(c.cluster)] || loose
    return k.region('claim-' + slug(c.id), { label: c.name, ref: refsOf(c), kind: kindOf(c), cluster: g.name },
      k.beside(
        k.text(`{c2:**+**} {${TONE[kindOf(c)]}:●} ${esc(c.name)}`, { w: nameW + 4, max: nameW + 4, wrap: false }),
        k.text(`{dim:${NAME[kindOf(c)]}}`, { w: 13, wrap: false }),
        k.text(`**${esc(g.name)}**`, { max: 26, wrap: false }),
        { gap: 2 }))
  })
  return k.frame(k.stack(rows), {
    title: `{c2:atlas}**{dim: · ${fresh.length} new claim${fresh.length === 1 ? '' : 's'} from this message}**`,
    right: `{c2:in the map · ${claims.length} claims}`,
    bottom,
  })
}

// ------------------------------------------------------------------ the detail view: every claim under its cluster
if (k.mode === 'detail') {
  const parts = []
  shown.forEach(g => {
    parts.push(k.text(`**${esc(g.name)}**  {dim:${g.claims.length} claim${g.claims.length === 1 ? '' : 's'}}`))
    g.claims.slice().sort((a, b) => ORDER[kindOf(a)] - ORDER[kindOf(b)] || weight(b) - weight(a)).forEach(c => {
      const refs = refsOf(c)
      const ev = (Array.isArray(c.evidence) ? c.evidence : []).filter(e => e && typeof e === 'object' && e.ref)
      const exId = 'ev-' + slug(c.id)
      if (ev.length) k.examples(exId, { label: `evidence for "${String(c.name).slice(0, 60)}"`, records: ev.map(e => ({ ref: e.ref, text: e.quote || e.note || e.ref })), total: ev.length, fmt: '{text}' })
      const n = typeof c.n === 'number' ? ` · in ${c.n}${typeof c.of === 'number' ? ' of ' + c.of : ''} ${unit}` : ''
      parts.push(k.region('claim-' + slug(c.id), { label: c.name, ref: refs, kind: kindOf(c), cluster: g.name, examples: ev.length ? exId : undefined, note: c.note || undefined },
        k.beside(
          k.text(`  {${TONE[kindOf(c)]}:●} ${esc(c.name)}`, { grow: 1, wrap: false }),
          k.text(`{dim:${NAME[kindOf(c)]} · ${refs.length} ref${refs.length === 1 ? '' : 's'}${n}}`, { wrap: false }),
          { gap: 2 })))
    })
    parts.push(k.space(1, 1))
  })
  parts.push(legend)
  return k.frame(k.stack(parts), { title: head, right: `{c2:${claims.length} claims · ${shown.filter(g => g.id).length} clusters}`, bottom })
}

// ------------------------------------------------------------------ under a reply: the cluster list
const nameW = Math.min(24, Math.max(10, ...shown.map(g => k.len(g.name) + 2)))
const most = Math.max(1, ...shown.map(g => g.claims.length))
const dotsW = Math.max(8, Math.min(26, most * 2 - 1, k.w - nameW - 46))
const spaced = most * 2 - 1 <= dotsW
const lines = []
const n = scope.n
const read = typeof n === 'number' ? `{dim:read ${k.fmt(n)} ${esc(unit)}  ·  }` : ''
lines.push(k.text(`${read}**${claims.length}** {dim:claim${claims.length === 1 ? '' : 's'} in} **${groups.filter(g => g.claims.length).length}** {dim:clusters}`))
lines.push(k.space(1, 1))
shown.forEach(g => {
  const lead = leadOf(g)
  const refs = []
  g.claims.forEach(c => refsOf(c).forEach(r => { if (refs.length < 40 && refs.indexOf(r) < 0) refs.push(r) }))
  const id = g.id == null ? 'cluster-between' : 'cluster-' + slug(g.id)
  const counts = KINDS.map(([kid]) => g.claims.filter(c => kindOf(c) === kid).length)
  lines.push(k.region(id, { label: g.name, ref: refs, claims: g.claims.map(c => c.id), kinds: counts, lead: lead && lead.name },
    k.beside(
      k.text(g.id == null ? `{dim:${esc(g.name)}}` : `**${esc(g.name)}**`, { w: nameW, max: nameW, wrap: false }),
      k.text(dotsOf(g.claims, dotsW, spaced), { w: dotsW + 1, wrap: false }),
      k.text(`**${g.claims.length}**`, { w: 3, align: 'right' }),
      k.text(lead ? esc(lead.name) : '', { grow: 1, wrap: false }),
      { gap: 2 })))
})
lines.push(k.space(1, 1))
lines.push(legend)
const right = data.building ? '{c2:building map}' : '{c2:map ready}'
return k.frame(k.stack(lines), { title: head, right, bottom })
