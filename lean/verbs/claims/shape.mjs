// shape.mjs: what the corpus orientation's claims file holds, checked only as far as the Claims store needs. No Node
// and no imports, so the verb, the CLI and the tests can all use it.
//
//   data = {
//     title, scope: {unit, n, what},                    what was read ("40 runs"), shown in the heading
//     clusters: [{id, name, lead?, note?}],             named groups of claims
//     claims: [{id, name, kind, cluster, evidence: [{ref, quote?} | ref], n?, of?, note?}],
//     relations: [{from, to, type}],                    type: contradicts | supports | same topic
//     added?: {claims: [ids], row?, at?}                the claims one message added (that version only)
//   }
//
// Any other field is kept. Nothing here judges whether a claim is true: `thimble verb claims check` runs the kernel's own
// check of each evidence ref and quote (check.py).

export const KINDS = [
  { id: 'fact', name: 'fact', tone: 'c4', color: '#5b6b82' },
  { id: 'finding', name: 'finding', tone: 'c1', color: '#1f8a84' },
  { id: 'judgment', name: 'judgment call', tone: 'c5', color: '#c25c8a' },
  { id: 'event', name: 'event', tone: 'c3', color: '#a8875a' },
  { id: 'claim', name: 'claim', tone: 'c2', color: '#7b5bb6' },
]
export const RELATIONS = ['contradicts', 'supports', 'same topic']

/** A kind as one of the five ids ("judgment call" and "judgement" read as judgment); null when it is none of them. */
export function kindOf(k) {
  const s = String(k == null ? '' : k).toLowerCase().trim()
  if (!s) return null
  if (s.startsWith('judg') || s === 'decision') return 'judgment'
  return KINDS.some(x => x.id === s) ? s : null
}

/** A relation type as one of the three ("contradiction", "supported by" reversed by the caller, "same", "topic"). */
export function relationOf(t) {
  const s = String(t == null ? '' : t).toLowerCase().trim()
  if (s.startsWith('contra') || s === 'x') return 'contradicts'
  if (s.startsWith('support') || s === 's') return 'supports'
  if (s.startsWith('same') || s === 'topic' || s === 't') return 'same topic'
  return null
}

/** The refs of a claim's evidence. */
export function refsOf(claim) {
  return (Array.isArray(claim?.evidence) ? claim.evidence : []).map(e => (typeof e === 'string' ? e : e && e.ref)).filter(x => typeof x === 'string' && x.trim())
}

/** The claims file's data from its object or from data itself. */
export function dataOf(o) {
  if (o && typeof o === 'object' && o.data && typeof o.data === 'object' && Array.isArray(o.data.claims)) return o.data
  return o && typeof o === 'object' ? o : {}
}

/**
 * Check a claims file (its object or its data) for what the store needs: claims with ids, names and known kinds, clusters
 * they name, relations between claims that exist, evidence on each claim.
 * @returns {{problems: string[], warnings: string[], counts: {claims, clusters, relations, refs, loose}}}
 */
export function check(file) {
  const d = dataOf(file)
  const problems = []
  const warnings = []
  const claims = Array.isArray(d.claims) ? d.claims : null
  const clusters = Array.isArray(d.clusters) ? d.clusters : []
  if (!claims) problems.push('data.claims is not a list: there is nothing to add')
  if (d.clusters != null && !Array.isArray(d.clusters)) problems.push('data.clusters is not a list')
  const cids = new Set()
  clusters.forEach((c, i) => {
    if (!c || c.id == null || String(c.id).trim() === '') { problems.push(`cluster ${i + 1} has no id`); return }
    if (cids.has(String(c.id))) problems.push(`cluster id "${c.id}" is used twice`)
    if (/^[qr]\d+(#.*)?$/.test(String(c.id))) problems.push(`cluster id "${c.id}" reads as a query ref when it is checked; name it in words`)
    cids.add(String(c.id))
    if (!c.name) warnings.push(`cluster "${c.id}" has no name; its id is shown`)
  })
  const ids = new Set()
  let refs = 0
  let loose = 0
  const used = new Set()
  for (const [i, c] of (claims || []).entries()) {
    const at = c && c.id != null ? `claim "${c.id}"` : `claim ${i + 1}`
    if (!c || typeof c !== 'object') { problems.push(`${at} is not an object`); continue }
    if (c.id == null || String(c.id).trim() === '') problems.push(`${at} has no id`)
    else if (ids.has(String(c.id))) problems.push(`${at}: the id is used twice`)
    else ids.add(String(c.id))
    if (/^[qr]\d+(#.*)?$/.test(String(c.id ?? ''))) problems.push(`${at}: an id of the form r<n> or q<n> reads as a query ref when it is checked; name it in words`)
    if (!c.name || typeof c.name !== 'string') problems.push(`${at} has no name`)
    else if (c.name.length > 120) warnings.push(`${at}: its name is ${c.name.length} characters; a name of under 80 reads in one row (put the rest in note)`)
    if (!kindOf(c.kind)) problems.push(`${at}: kind "${c.kind}" is not one of fact, finding, judgment call, event, claim`)
    if (c.cluster != null && c.cluster !== '' && !cids.has(String(c.cluster))) problems.push(`${at}: cluster "${c.cluster}" is not in data.clusters`)
    if (c.cluster == null || c.cluster === '') loose++
    else used.add(String(c.cluster))
    const r = refsOf(c)
    if (c.evidence != null && !Array.isArray(c.evidence)) problems.push(`${at}: evidence is not a list`)
    if (!r.length) problems.push(`${at} has no evidence ref: a claim nobody can open cannot be checked`)
    refs += r.length
  }
  clusters.forEach(c => { if (c && c.id != null && !used.has(String(c.id))) warnings.push(`cluster "${c.id}" has no claims; it is not drawn`) })
  const rels = Array.isArray(d.relations) ? d.relations : []
  if (d.relations != null && !Array.isArray(d.relations)) problems.push('data.relations is not a list')
  rels.forEach((r, i) => {
    if (!r || typeof r !== 'object') { problems.push(`relation ${i + 1} is not an object`); return }
    if (!ids.has(String(r.from))) problems.push(`relation ${i + 1}: from "${r.from}" is not a claim id`)
    if (!ids.has(String(r.to))) problems.push(`relation ${i + 1}: to "${r.to}" is not a claim id`)
    if (!relationOf(r.type)) problems.push(`relation ${i + 1}: type "${r.type}" is not contradicts, supports or same topic`)
    if (String(r.from) === String(r.to)) warnings.push(`relation ${i + 1} links "${r.from}" to itself`)
  })
  if (d.added != null) {
    const a = Array.isArray(d.added.claims) ? d.added.claims : null
    if (!a) problems.push('data.added.claims is not a list')
    else a.forEach(id => { if (!ids.has(String(id))) problems.push(`data.added names "${id}", which is not a claim id`) })
  }
  return { problems, warnings, counts: { claims: (claims || []).length, clusters: used.size, relations: rels.length, refs, loose } }
}

/** One line on what the file holds: "53 claims in 6 clusters · 88 relations · 141 evidence refs". */
export function summary(file) {
  const { counts: c } = check(file)
  return `${c.claims} claim${c.claims === 1 ? '' : 's'} in ${c.clusters} cluster${c.clusters === 1 ? '' : 's'} · ${c.relations} relation${c.relations === 1 ? '' : 's'} · ${c.refs} evidence ref${c.refs === 1 ? '' : 's'}`
}

/**
 * The spec the kernel's citation check reads for a claims file: the file's object (or its bare data wrapped), with each
 * evidence ref as {ref} (a bare string that reads as a query ref would be replaced by its value). `added` is dropped
 * unless `keepAdded`.
 */
export function specFor(json, program, { keepAdded = false } = {}) {
  const wrapped = json && typeof json === 'object' && json.data && typeof json.data === 'object' && !Array.isArray(json.data)
  const spec = wrapped ? { ...json } : { data: json && typeof json === 'object' ? json : {} }
  const data = { ...spec.data }
  if (!keepAdded) delete data.added
  if (Array.isArray(data.claims)) {
    data.claims = data.claims.map(c => (c && typeof c === 'object' && Array.isArray(c.evidence)
      ? { ...c, evidence: c.evidence.map(e => (typeof e === 'string' ? { ref: e } : e)) }
      : c))
  }
  spec.data = data
  spec.title = spec.title || data.title || 'claims'
  if (!data.title && spec.title !== 'claims') data.title = spec.title
  spec.verb = 'claims'
  if (program) spec.program = program
  return spec
}
