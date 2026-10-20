// The folder's map of claims as a card (the body of a function (k, data) => node, on the card runtime). A subagent of
// main writes the map and saves it as `folder-claims` with this program; the session's Claims pane (c) shows its
// claims beside the session's own. Under a reply: one row per cluster, its name, a dot per claim in the color of its
// kind, how many, and its lead claim. In the detail: every claim under its cluster, each a part whose examples are its
// evidence rows.
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
const legend = k.text(KINDS.map(([id, name, tone]) => `{${tone}:●} {dim:${name}}`).join('   '), { wrap: false })
const leadOf = g => g.claims.find(c => g.lead != null && String(c.id) === String(g.lead)) || g.claims.slice().sort((a, b) => (b.n || 0) - (a.n || 0) || refsOf(b).length - refsOf(a).length)[0]
const title = `{c2:the folder's claims}${data.title ? `**{dim: · ${esc(data.title)}}**` : ''}`
const right = `{c2:${claims.length} claims · ${shown.filter(g => g.id).length} clusters · c opens them}`

if (k.mode === 'detail') {
  const parts = []
  shown.forEach(g => {
    parts.push(k.text(`**${esc(g.name)}**  {dim:${g.claims.length} claim${g.claims.length === 1 ? '' : 's'}}`))
    g.claims.slice().sort((a, b) => ORDER[kindOf(a)] - ORDER[kindOf(b)]).forEach(c => {
      const ev = (Array.isArray(c.evidence) ? c.evidence : []).filter(e => e && typeof e === 'object' && e.ref)
      const exId = 'ev-' + slug(c.id)
      if (ev.length) k.examples(exId, { label: `evidence for "${String(c.name).slice(0, 60)}"`, records: ev.map(e => ({ ref: e.ref, text: e.quote || e.ref })), total: ev.length, fmt: '{text}' })
      const n = typeof c.n === 'number' ? ` · in ${c.n}${typeof c.of === 'number' ? ' of ' + c.of : ''} ${unit}` : ''
      parts.push(k.region('claim-' + slug(c.id), { label: c.name, ref: refsOf(c), examples: ev.length ? exId : undefined },
        k.beside(k.text(`  {${TONE[kindOf(c)]}:●} ${esc(c.name)}`, { grow: 1, wrap: false }), k.text(`{dim:${NAME[kindOf(c)]}${n}}`, { wrap: false }), { gap: 2 })))
    })
    parts.push(k.space(1, 1))
  })
  parts.push(legend)
  return k.frame(k.stack(parts), { title, right })
}

const nameW = Math.min(30, Math.max(10, ...shown.map(g => k.len(g.name) + 2)))
const most = Math.max(1, ...shown.map(g => g.claims.length))
const dotsW = Math.max(6, Math.min(24, most + 1))
const lines = []
lines.push(k.text(`${typeof scope.n === 'number' ? `{dim:read ${k.fmt(scope.n)} ${esc(unit)}  ·  }` : ''}**${claims.length}** {dim:claim${claims.length === 1 ? '' : 's'} in} **${shown.filter(g => g.id).length}** {dim:clusters}`))
lines.push(k.space(1, 1))
shown.forEach(g => {
  const lead = leadOf(g)
  const sorted = g.claims.slice().sort((a, b) => ORDER[kindOf(a)] - ORDER[kindOf(b)])
  const dots = sorted.slice(0, dotsW - 1).map(c => `{${TONE[kindOf(c)]}:●}`).join('') + (sorted.length > dotsW - 1 ? '{dim:+}' : '')
  lines.push(k.region(g.id == null ? 'cluster-between' : 'cluster-' + slug(g.id), { label: g.name, ref: g.claims.flatMap(refsOf).slice(0, 40) },
    k.beside(
      k.text(g.id == null ? `{dim:${esc(g.name)}}` : `**${esc(g.name)}**`, { w: nameW, wrap: false }),
      k.text(dots, { w: dotsW, wrap: false }),
      k.text(`**${g.claims.length}**`, { w: 3, align: 'right' }),
      k.text(lead ? esc(lead.name) : '', { grow: 1, wrap: false }),
      { gap: 2 })))
})
lines.push(k.space(1, 1))
lines.push(legend)
return k.frame(k.stack(lines), { title, right })
