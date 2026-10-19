// evidence.js: what the observer reads of the objects Claude saved, in a few lines each, and how it reads the
// observer's answer back. No `$`, no Node, no DOM: the hooks module imports it, and the tests run it under Node.
//
// The fork already has the conversation (every `lean q` and `lean save` call and its output). What it does not have
// in a few words is what the kernel knows about each object: how many rows stand behind each value it cites, how sure
// each query's row lineage is, which files fed it and which the session never read, what Claude said it read or
// judged by hand, the problems `lean save` found, and the verbs that could act on it. That is what this writes.
//
//   rowCount(rowsets)          -> how many source rows a list of row sets names (null when one names a whole file)
//   slim(object)               -> the object with only what digest reads: no data, no program, row sets as counts
//   bareNumbers(text)          -> the numbers in an object's words that cite nothing
//   digest(object, o)          -> the object's lineage in plain lines, as the person sees it, with its verb candidates
//   parseAnswer(text)          -> {notes, line, settled, hints, verbs, glosses} from the fork's reply, or null
//   pickHints(list, verbs)     -> the 2-3 verbs the observer chose for one object, checked against the verbs that exist

const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n))
const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, n - 1) + '…'
}

/** How many rows a row set names: `f.jsonl#L4-9,12` is 7, `f.jsonl#L12.b1` is 1, `db#prs/1-12` is 12. */
export function rowsIn(rowset) {
  const s = String(rowset || '')
  const hash = s.indexOf('#')
  if (hash < 0) return null
  const frag = s.slice(hash + 1)
  if (/^L\d+\.b\d+$/.test(frag)) return 1
  const two = /^L(\d+)-L(\d+)$/.exec(frag)
  if (two) return Math.max(0, Number(two[2]) - Number(two[1]) + 1)
  const m = /(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(frag)
  if (!m) return 1
  let n = 0
  for (const part of m[1].split(',')) {
    const [a, b] = part.split('-').map(Number)
    n += b === undefined ? 1 : Math.max(0, b - a + 1)
  }
  return n
}

/** How many source rows a list of row sets names; null when one of them is a whole file. */
export function rowCount(rowsets) {
  let n = 0
  for (const rs of Array.isArray(rowsets) ? rowsets : []) {
    const k = rowsIn(rs)
    if (k == null) return null
    n += k
  }
  return n
}

const filesOf = rowsets => [...new Set((Array.isArray(rowsets) ? rowsets : []).map(x => String(x).split('#')[0]))]

// what a query's row lineage mode means for the values that rest on it (kernel/query.py, output_lineage)
const MODES = {
  exact: 'each output row keeps its exact source rows',
  matched: 'rows found by key; their number equals the count column',
  superset: 'rows found by key, but their number does not equal the count column: the rows behind a value hold more than it counts (a filter or a second key the rows do not show)',
  key: 'rows found by key only; nothing checks them against the value',
  query: 'no source rows: its values open to the query only',
}

const NUM = /(?<![\w.#@/-])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\d,]*\d)/g

/** The numbers in prose that are not inside a citation `[label](ref)`, nor a year or a date. */
export function bareNumbers(text) {
  const plain = String(text || '').replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, ' ').replace(/`[^`]*`/g, ' ')
  const out = []
  for (const m of plain.matchAll(NUM)) {
    const t = m[0]
    if (/^(19|20)\d\d$/.test(t)) continue // a year
    const after = plain.slice(m.index + t.length, m.index + t.length + 3)
    if (/^-\d/.test(after) || /^:\d/.test(after)) continue // a date or a time
    if (/^\d$/.test(t)) continue // one digit counts things like "one of 3 parts" too often to mean a value
    if (!out.includes(t)) out.push(t)
  }
  return out
}

function citeLine(c) {
  const rows = c.rows_n !== undefined ? c.rows_n : rowCount(c.rows)
  const files = c.rows_files || filesOf(c.rows)
  const label = c.label != null ? `"${cut(c.label, 40)}"` : c.quote != null ? `quote "${cut(c.quote, 50)}"` : 'a value'
  const value = c.value !== undefined ? ` = ${typeof c.value === 'number' ? fmt(c.value) : cut(JSON.stringify(c.value), 30)}` : ''
  const behind = rows != null ? `rests on ${fmt(rows)} row${rows === 1 ? '' : 's'}${files.length ? ' of ' + files.slice(0, 2).join(', ') : ''}` : files.length ? `rests on all of ${files.slice(0, 2).join(', ')}` : 'rests on no rows'
  const problem = c.problem ? ` · PROBLEM: ${cut(c.problem, 140)}` : ''
  return `${label}${value} (${cut(c.ref, 60)}): ${behind}${problem}`
}

/**
 * One object's lineage in plain lines, for the observer's prompt.
 *   o.drawn   the object as the person sees it: its drawing as plain text
 *   o.verbs   the verbs for it as the shell lists them: [{key, name, line, phrase, picked}]
 *   o.isNew   whether it was saved in the turns since the observer last looked
 */
export function digest(object, o = {}) {
  if (!object || typeof object !== 'object') return ''
  const lin = object.lineage || {}
  const L = []
  L.push(`Object ${object.id} v${object.version ?? '?'} "${cut(object.title || '', 80)}"${o.isNew ? ' (saved since the last look)' : ''}`)
  if (object.question) L.push(`  asked: ${cut(object.question, 200)}`)
  if (object.verb) L.push(`  made by the verb ${object.verb}, which the person pressed`)
  if (object.text) L.push(`  its words: ${cut(object.text, 700)}`)
  const bare = bareNumbers(object.text)
  if (bare.length) L.push(`  numbers in its words that cite nothing: ${bare.slice(0, 12).join(', ')}`)
  const textCites = (lin.cites || []).filter(c => c.in === 'text')
  const otherCites = (lin.cites || []).filter(c => c.in !== 'text')
  if (textCites.length) {
    L.push('  values its words cite:')
    for (const c of textCites.slice(0, 12)) L.push(`    ${citeLine(c)}`)
    if (textCites.length > 12) L.push(`    … and ${textCites.length - 12} more`)
  }
  if (otherCites.length) {
    const bad = otherCites.filter(c => c.problem)
    L.push(`  records it quotes or cites in its data: ${otherCites.length}${bad.length ? `, ${bad.length} with a problem: ${bad.slice(0, 3).map(c => cut(c.problem, 100)).join('; ')}` : ', each found in its row'}`)
  }
  const binds = lin.bindings || []
  if (binds.length) L.push(`  data bound to queries: ${binds.slice(0, 8).map(b => `${b.at || '/'} ← ${b.ref}${b.lineage && b.lineage !== 'exact' ? ` (${b.lineage})` : ''}`).join('; ')}`)
  const qs = Object.values(lin.queries || {})
  for (const q of qs.slice(0, 8)) {
    const inputs = fewInputs(q.inputs).map(x => `${x.path}${x.rows_read != null ? ` (${fmt(x.rows_read)} rows read)` : ''}`).join(', ')
    const uses = (q.uses || []).map(u => (typeof u === 'string' ? u : `${u.name || u.label || u.query}${u.version != null ? ' v' + u.version : ''}${u.query ? ' from ' + u.query : ''}`)).filter(Boolean)
    const kept = Array.isArray(q.kept) && q.kept.length ? `; keeps ${q.kept.join(', ')} for later queries` : ''
    const mode = MODES[q.lineage] ? `; ${MODES[q.lineage]}` : ''
    L.push(`  query ${q.id} "${cut(q.about || '', 90)}": ${inputs || 'no source files'}${uses.length ? `; uses ${uses.join(', ')}` : ''}${kept}${mode}${q.rerun_of ? `; a rerun of ${q.rerun_of}` : ''}`)
  }
  if (qs.length > 8) L.push(`  … and ${qs.length - 8} more queries`)
  const rows = lin.rows || {}
  const rf = Object.entries(rows)
  if (rf.length) L.push(`  source rows behind its values: ${rf.slice(0, 6).map(([f, r]) => `${f} ${fmt(r.count)}`).join(', ')}`)
  const cov = lin.coverage || {}
  if (cov.files || cov.not_read) {
    const by = {}
    for (const [f, st] of Object.entries(cov.files || {})) (by[st] ??= []).push(f)
    const parts = Object.entries(by).map(([st, fs]) => `${st} ${fs.length > 4 ? `${fs.length} files` : fs.join(', ')}`)
    const nr = cov.not_read || []
    const nn = cov.not_read_count ?? nr.length
    if (nn) parts.push(`not read ${nn > 6 ? `${fmt(nn)} files, as ${nr.slice(0, 4).join(', ')}` : nr.join(', ')}`)
    L.push(`  when it was saved the session had: ${parts.join('; ')}`)
  }
  const dec = lin.declared ?? object.declared
  if (dec && typeof dec === 'object' && Object.keys(dec).length) L.push(`  Claude declared: ${Object.entries(dec).map(([k, v]) => `${k}: ${cut(typeof v === 'string' ? v : JSON.stringify(v), 220)}`).join('; ')}`)
  else L.push('  Claude declared nothing it read or judged by hand')
  const probs = lin.problems || []
  if (probs.length) L.push(`  problems lean save found: ${probs.slice(0, 5).map(p => cut(p, 140)).join('; ')}`)
  if (typeof o.drawn === 'string' && o.drawn.trim()) {
    const lines = o.drawn.split('\n').filter(l => l.trim())
    const shown = lines.slice(0, 30).map(l => `    ${cut(l, 130)}`)
    L.push(`  as the person sees it under the reply:\n${shown.join('\n')}${lines.length > 30 ? `\n    … ${lines.length - 30} more lines` : ''}`)
  }
  const verbs = Array.isArray(o.verbs) ? o.verbs : []
  if (verbs.length) {
    const named = Array.isArray(object.hints) ? object.hints.map(h => (typeof h === 'string' ? h : h?.verb || h?.name)).filter(Boolean) : []
    L.push(`  verbs that can act on it (key name: what it does${verbs.some(v => v.phrase) ? ' · its own hint for this object' : ''}):`)
    for (const v of verbs) L.push(`    ${v.key || '-'} ${v.name}: ${cut(v.line, 90)}${v.phrase ? ` · ${cut(v.phrase, 60)}` : ''}`)
    L.push(`  its hint row now: ${verbs.filter(v => v.picked).map(v => v.name).join(', ') || 'none'}${named.length ? ` (Claude named ${named.join(', ')})` : ''}`)
  }
  return L.join('\n')
}

/** A query's inputs in a few lines: many like files (a run's 776 transcripts) as one pattern with how many files and
 *  rows, as `runs/sweep*-opus-emergent_prs/agents/agent-*.jsonl (48 files)`, each segment's digits starred. */
export function fewInputs(inputs, max = 6) {
  const list = Array.isArray(inputs) ? inputs : []
  if (list.length <= max) return list
  const groups = new Map()
  for (const x of list) {
    const key = String(x.path || '').split('/').map(seg => seg.replace(/\d+/g, '*')).join('/')
    const g = groups.get(key) || { n: 0, rows: 0 }
    g.n += 1
    g.rows += Number(x.rows_read) || 0
    groups.set(key, g)
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].n - a[1].n)
  const out = ranked.slice(0, 4).map(([k, g]) => ({ path: `${k} (${fmt(g.n)} files)`, rows_read: g.rows }))
  const rest = ranked.slice(4)
  if (rest.length) out.push({ path: `${fmt(rest.reduce((n, [, g]) => n + g.n, 0))} other files`, rows_read: rest.reduce((n, [, g]) => n + g.rows, 0) })
  return out
}

/** The object with only what `digest` reads: its words, its lineage without query code, each citation's row sets as a
 *  count and a list of files, at most 40 citations. Small, whatever the object's data: an object of a swarm can hold
 *  megabytes of rows. */
export function slim(o) {
  if (!o || typeof o !== 'object') return null
  const lin = o.lineage || {}
  const cites = (lin.cites || []).slice(0, 40).map(c => {
    const { rows, quote, ...rest } = c
    // a citation whose rows the kernel packed (store.pack_object) keeps their count and files beside it
    const counted = rows === undefined && rest.rows_n !== undefined
    return { ...rest, ...(quote != null ? { quote: cut(quote, 120) } : {}), rows_n: counted ? rest.rows_n : rowCount(rows), rows_files: counted ? rest.rows_files || [] : filesOf(rows) }
  })
  const queries = {}
  for (const [k, q] of Object.entries(lin.queries || {}).slice(0, 12)) {
    const { code, ...rest } = q || {}
    queries[k] = { ...rest, inputs: fewInputs(rest.inputs) }
  }
  const rows = {}
  for (const [f, r] of Object.entries(lin.rows || {})) rows[f] = { count: r && r.count }
  const cov = lin.coverage || {}
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => x[k] !== undefined).map(k => [k, x[k]]))
  return {
    ...pick(o, ['id', 'version', 'session', 'created', 'updated', 'title', 'question', 'text', 'hints', 'verb', 'declared']),
    lineage: {
      queries, bindings: (lin.bindings || []).slice(0, 20).map(b => pick(b, ['at', 'ref', 'query', 'lineage'])), cites, rows,
      coverage: { files: cov.files || {}, not_read: (cov.not_read || []).slice(0, 30), not_read_count: (cov.not_read || []).length },
      declared: lin.declared, problems: (lin.problems || []).slice(0, 10),
      ...(lin.cites && lin.cites.length > 40 ? { cites_count: lin.cites.length } : {}),
    },
  }
}

/** The JSON object in a reply, or null. */
export function jsonIn(text) {
  const t = String(text || '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(t.slice(a, b + 1))
  } catch {
    return null
  }
}

/** The fork's reply, read leniently: notes, a line, whether the open line is settled, and the hints per object. */
export function parseAnswer(text) {
  const d = jsonIn(text)
  if (!d || typeof d !== 'object') return null
  const notes = (Array.isArray(d.notes) ? d.notes : [])
    .map(n => (typeof n === 'string' ? { note: n } : n))
    .filter(n => n && typeof n.note === 'string' && n.note.trim())
    .map(n => ({ note: n.note.trim(), ...(typeof n.rests_on === 'string' && n.rests_on.trim() ? { rests_on: n.rests_on.trim() } : {}) }))
  const L = d.line && typeof d.line === 'object' && typeof d.line.line === 'string' && d.line.line.trim() ? d.line : null
  const line = L
    ? {
        line: L.line.trim(),
        decision: typeof L.decision === 'string' ? L.decision.trim() : '',
        title: typeof L.title === 'string' && L.title.trim() ? L.title.trim() : L.line.trim(),
        explanation: typeof L.explanation === 'string' ? L.explanation.trim() : '',
        rests_on: typeof L.rests_on === 'string' ? L.rests_on.trim() : '',
      }
    : null
  const hints = d.hints && typeof d.hints === 'object' && !Array.isArray(d.hints) ? d.hints : {}
  // the message row: the verbs it lights and its glosses, read as given (shell/message.js verbsOf and glossesOf check them)
  const verbs = d.verbs && typeof d.verbs === 'object' && !Array.isArray(d.verbs) ? d.verbs : {}
  const glosses = Array.isArray(d.glosses) ? d.glosses : []
  // the turn's claims and the clusters' renames, read as given (verbs/claims/claims.js applyTurn checks them)
  const claims = Array.isArray(d.claims) ? d.claims : []
  const clusters = Array.isArray(d.clusters) ? d.clusters : []
  return { notes, line, settled: d.settled === true, hints, verbs, glosses, claims, clusters }
}

/** The observer's choice for one object, kept only where it names a verb that exists: at most three, each with its
 *  phrase cut to a hint's length. [] when it chose nothing usable (the shell's own rule then stays). */
export function pickHints(list, verbs, max = 3) {
  const out = []
  for (const h of Array.isArray(list) ? list : []) {
    const word = String(typeof h === 'string' ? h : h?.verb ?? h?.name ?? '').trim().toLowerCase()
    const v = (verbs || []).find(x => x.name.toLowerCase() === word || (x.key && x.key === word))
    if (!v || out.some(x => x.verb === v.name)) continue
    const phrase = typeof h === 'object' && typeof h?.phrase === 'string' ? cut(h.phrase, 40) : ''
    out.push({ verb: v.name, ...(phrase ? { phrase } : {}) })
    if (out.length >= max) break
  }
  return out
}

/** The hints the fork gave for an object, found by its id or by its id without the number (`saves-per-day`). */
export function hintsFor(hints, id) {
  if (!hints || typeof hints !== 'object') return null
  if (hints[id]) return hints[id]
  const slug = String(id).replace(/^\d+-/, '')
  for (const [k, v] of Object.entries(hints)) if (String(k).replace(/^\d+-/, '') === slug) return v
  return null
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Whether a line says the same as one in the list (the same words, or nearly). */
export function isRepeat(line, list) {
  const a = norm(line)
  return (list || []).some(x => norm(x) === a)
}
