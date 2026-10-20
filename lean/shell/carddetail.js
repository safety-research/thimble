// carddetail.js: the card detail's state, as pure functions. No `$`, no Node, no DOM: the terminal (detail.tsx) and the
// browser page (browser/card/card.js) both use it, so the two say the same thing.
//
// The detail has one pattern for every card ("overview first, zoom and filter, details on demand"): a header (title,
// takeaway, v1 · v2), the card enlarged with its parts, and a bar under it that starts empty and fills on demand with
// the examples of the selected part, labelled with what they are examples of, and their "from" line. The card's
// thread is the chat beside it, and the program is behind `p`.
//
//   partsOf(grid)                 the parts a person selects, in reading order: [{id, label, rects, knob?}]
//   stepPart(parts, at, dir)      the part after `at` (dir 1) or before it (dir -1), wrapping
//   versionsOf(object, seen)      [{v, at, change, seen?, drafts?}] from the latest object's history, with which ones the
//                                 person saw (runtime.ts readSeen)
//   shownVersions(versions, v)    the versions the header lists: those seen, and the one shown
//   PAGES_DEFAULT                 how a card with pages opens: 'all' (every page, one after another) or 'one'
//   stepVersion(versions, v)      the version `h` goes to: the one before, and from v1 the latest
//   keyOf(key, ctx)               what a key does in the detail, or null; keys act only while the composer is empty
//   exampleSet(drawing, meta)     the examples the program attached to a part, or null
//   recordWords(rec, o)           a record as the person reads it: {words, meta}, never a dump of field: value
//   examplesView(records, o)      how a set reads: a table of short rows, or lines of words with their meta
//   fromLine(facts, o)            the "from" line: sources · rows used · labels · coverage, as segments
//   programLines(program, id)     the program's lines that drew a part (1-based), for the overlay behind `p`
//   linkRuns(text)                Claude's words with their citations: [{s, link?}]

const n = x => (typeof x === 'number' && isFinite(x) ? x.toLocaleString('en-US') : String(x ?? ''))

// ---------------------------------------------------------------------------------------------- pages

/** How a card with pages (a page knob, kit.js) opens in the detail: 'all', every page one after another under its own
 *  heading, to scroll through; or 'one', a page at a time. `a` switches between them; `1` and "read all" open so. */
export const PAGES_DEFAULT = 'all'

// ---------------------------------------------------------------------------------------------- parts

/** The parts a person selects: each region drawn with at least one cell, in reading order (top to bottom, then left to
 *  right). A knob's dial is a part too, so it can be selected and turned. A link to a cite or an examples set is not. */
export function partsOf(grid) {
  const out = []
  for (const r of grid?.regions || []) {
    if (!r.rects || !r.rects.length) continue
    if (r.link && !r.meta?.knob) continue
    if (out.some(p => p.id === r.id)) continue
    out.push({ id: r.id, label: String(r.meta?.label || r.id), rects: r.rects, ...(r.meta?.knob ? { knob: r.meta.knob } : {}) })
  }
  const at = p => p.rects.reduce((a, q) => (q.y < a.y || (q.y === a.y && q.x < a.x) ? q : a), p.rects[0])
  return out.sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x)
}

/** The first cell of a part: where its marker and the focus ring go. */
export function partTop(part) {
  if (!part || !part.rects?.length) return null
  return part.rects.reduce((a, q) => (q.y < a.y || (q.y === a.y && q.x < a.x) ? q : a), part.rects[0])
}

export function stepPart(parts, at, dir = 1) {
  if (!parts || !parts.length) return null
  const i = parts.findIndex(p => p.id === at)
  if (i < 0) return parts[dir > 0 ? 0 : parts.length - 1].id
  return parts[(i + (dir > 0 ? 1 : -1) + parts.length) % parts.length].id
}

// ---------------------------------------------------------------------------------------------- versions

/** Every version, oldest first. With `seen` (the versions the person could see; null when no record was kept), each
 *  says whether it was seen, and a seen one how many unseen drafts came just before it. The latest always counts. */
export function versionsOf(object, seen = null) {
  const h = Array.isArray(object?.history) ? object.history : []
  const out = h.filter(x => x && x.v != null).map(x => ({ v: Number(x.v), at: x.at || null, change: x.change || null }))
  if (!out.length && object?.version != null) out.push({ v: Number(object.version), at: object.updated || null, change: null })
  out.sort((a, b) => a.v - b.v)
  if (Array.isArray(seen)) {
    const was = new Set(seen.map(Number))
    const last = out.length ? out[out.length - 1].v : null
    let drafts = 0
    for (const x of out) {
      x.seen = was.has(x.v) || x.v === last
      if (!x.seen) drafts++
      else { if (drafts) x.drafts = drafts; drafts = 0 }
    }
  }
  return out
}

/** The versions the header lists: those the person saw (all, when no record says), and the one shown now. */
export function shownVersions(versions, v) {
  return (versions || []).filter(x => x.seen !== false || x.v === v)
}

/** `h` steps back one version; from the first it goes to the latest again (B4: v2 → v1 → v2). */
export function stepVersion(versions, v) {
  if (!versions || versions.length < 2) return v
  const i = versions.findIndex(x => x.v === v)
  return i <= 0 ? versions[versions.length - 1].v : versions[i - 1].v
}

// ---------------------------------------------------------------------------------------------- keys

/**
 * What one key does in the detail, or null for a key the detail leaves alone (it types, or Claude Code has it).
 * Keys act only while the composer is empty, so a question that has begun types every letter it holds. Details come on
 * demand: the bar under the card starts empty; ↵ on a part fills it with the part's details, `e` adds its examples
 * (labelled with what they are examples of), and `0` or `esc` empties it again. A card that has a `zoom` knob zooms
 * with + and −, and one with a `filter` knob filters with f.
 *   ctx: {composer: the prompt's text, bar: what the bar shows (null, 'details' or 'examples'), overlay: whether the
 *         program is shown, knob: whether the selected part is a knob, zoom, filter: whether the card has those knobs,
 *         versions: how many, thread: whether the card has a thread}
 */
export function keyOf(key, ctx = {}) {
  if (ctx.composer) return null
  switch (key) {
    case 'down': case 'tab': return { act: 'part', dir: 1 }
    case 'up': case 'shift+tab': return { act: 'part', dir: -1 }
    case 'return': case 'enter': return { act: 'details' }
    case 'e': return { act: 'examples' }
    case ']': return { act: 'example', dir: 1 }
    case '[': return { act: 'example', dir: -1 }
    case '+': case '=': return ctx.zoom ? { act: 'zoom', dir: 1 } : null
    case '-': return ctx.zoom ? { act: 'zoom', dir: -1 } : null
    case 'f': return ctx.filter ? { act: 'filter' } : null
    case 'p': return { act: 'program' }
    case 'h': return ctx.versions > 1 ? { act: 'version' } : null
    case '.': case '>': return ctx.knob ? { act: 'knob', dir: 1 } : null
    case ',': case '<': return ctx.knob ? { act: 'knob', dir: -1 } : null
    case 'm': return ctx.thread ? { act: 'main' } : null
    case 't': return ctx.thread ? { act: 'thread' } : null
    case 'o': return ctx.browser ? { act: 'browser' } : null
    case '0': return ctx.bar || ctx.overlay ? { act: 'back' } : null
    case 'esc': return ctx.bar || ctx.overlay ? { act: 'back' } : { act: 'close' }
    default: return null
  }
}

/** The bar after a key: ↵ toggles the details, e the examples (which come with their details), back empties it. */
export function barAfter(bar, act) {
  if (act === 'details') return bar ? null : 'details'
  if (act === 'examples') return bar === 'examples' ? 'details' : 'examples'
  if (act === 'example') return 'examples'
  if (act === 'back') return bar === 'examples' ? 'details' : null
  return bar ?? null
}

/** The knob a key turns: `zoom` (or one whose label says zoom) for + and −, `filter` for f. */
export function namedKnob(drawing, name) {
  const cs = (drawing && drawing.controls) || []
  return cs.find(c => c.id === name) || cs.find(c => String(c.label || '').toLowerCase().includes(name)) || null
}

/** The next value of a filter: it cycles, so f goes all → failures only → all. */
export function cycleKnob(control, state) {
  if (!control) return state
  const i = (control.i + 1) % control.values.length
  return { ...(state || {}), [control.id]: control.values[i] }
}

/** A key that acted, then a letter typed straight after it: the key began a word. The letters go back to the prompt
 *  and the key's act is undone. `ms` since the key acted. */
export function beganWord(lastKey, ms, typed) {
  return !!lastKey && /^[a-z]$/.test(lastKey) && ms < 700 && typeof typed === 'string' && /^[\p{L}' ]$/u.test(typed)
}

/** What a field of the ask line reports as typed, joined to the question being typed (`draft`). The letters a field
 *  took after `seen` (what it held when drawn, or when last heard) join the end of the question, in the order they
 *  came: so letters that reached the question at the prompt while the field was drawn again are kept. In the field of
 *  the question now (`current`) any other change (a letter deleted, the cursor moved back) is the question as it reads.
 *  A field drawn before it (an earlier question's) changes nothing but by letters it took. */
export function askMerge(draft, seen, value, current) {
  const v = String(value ?? '')
  if (current) return v.startsWith(seen) ? { draft: draft + v.slice(seen.length), seen: v, added: '' } : { draft: v, seen: v, added: '' }
  if (!v.startsWith(seen)) return { draft, seen, added: '' }
  const added = v.slice(seen.length)
  return { draft: draft + added, seen: v, added }
}

// ---------------------------------------------------------------------------------------------- examples

/** The examples the program attached to a part (k.examples), or null. */
export function exampleSet(drawing, meta) {
  const id = meta && typeof meta.examples === 'string' ? meta.examples : null
  const set = id ? drawing?.examples?.[id] : null
  return set && Array.isArray(set.records) && set.records.length ? set : null
}

// the fields that hold a record's words, best first; then the fields that say whose and where it is
const WORD_KEYS = ['text', 'quote', 'summary', 'title', 'message', 'msg', 'body', 'content', 'comment', 'description', 'subject', 'note', 'change_summary', 'reason', 'answer', 'question', 'prompt', 'words']
const META_KEYS = ['user', 'author', 'agent', 'sender', 'name', 'label', 'page', 'run', 'step', 'epoch', 'rev', 'line', 'kind', 'type', 'event_type', 'activity', 'day', 'date', 'time']
const oneLine = s => String(s).replace(/\s+/g, ' ').trim()

/** The words of a transcript row (a message with content blocks): its first text, else its first tool call. */
function messageWords(v) {
  const c = v?.message?.content ?? v?.content
  if (typeof c === 'string') return oneLine(c)
  if (!Array.isArray(c)) return ''
  const text = c.find(b => b && b.type === 'text' && String(b.text || '').trim())
  if (text) return oneLine(text.text)
  const call = c.find(b => b && b.type === 'tool_use')
  if (call) { const i = call.input || {}; return oneLine(`${call.name}: ${i.command ?? i.file_path ?? i.pattern ?? i.description ?? JSON.stringify(i)}`) }
  const res = c.find(b => b && b.type === 'tool_result')
  if (res) return oneLine(typeof res.content === 'string' ? res.content : (res.content || []).map(x => x?.text || '').join(' '))
  return ''
}

/**
 * One record as the person reads it: its meaningful words (the field the card is about when `fields` names it, else its
 * text, title, summary, message and the like, else its longest words) and a short meta line of whose and where it is.
 * A record from `thimble resolve` carries `words` and `meta` from the kernel; one with only `text` reads as that.
 *   o: {fields: the fields the card is about, as a region's meta or an examples set names them}
 */
export function recordWords(rec, o = {}) {
  if (rec == null) return { words: '', meta: '' }
  if (typeof rec !== 'object') return { words: oneLine(rec), meta: '' }
  // a row the kernel read back: {ref, text, words?, meta?, value?}
  if (typeof rec.ref === 'string' && (rec.words != null || rec.text != null) && rec.value === undefined) {
    const where = rec.ref.replace(/^.*\//, '')
    return { words: oneLine(rec.words ?? rec.text ?? ''), meta: [oneLine(rec.meta ?? ''), where].filter(Boolean).join(' · ') }
  }
  const v = rec.value !== undefined && rec.value && typeof rec.value === 'object' ? rec.value : rec
  const where = typeof rec.ref === 'string' && rec.value !== undefined ? rec.ref : ''
  const fields = (Array.isArray(o.fields) ? o.fields : []).filter(f => v[f] != null && v[f] !== '')
  let wordKey = null
  let words = ''
  if (fields.length) {
    // the fields the card names: the longest string of them is the words, the rest join the meta
    const strs = fields.filter(f => typeof v[f] === 'string')
    wordKey = strs.length ? strs.reduce((a, b) => (String(v[b]).length > String(v[a]).length ? b : a)) : fields[0]
    words = oneLine(v[wordKey])
  }
  if (!words && (v.type === 'assistant' || v.type === 'user') && (v.message || v.content)) words = messageWords(v)
  if (!words) {
    wordKey = WORD_KEYS.find(k => typeof v[k] === 'string' && v[k].trim()) || null
    if (wordKey) words = oneLine(v[wordKey])
  }
  if (!words) {
    // no field by those names: the longest words in it, when they read as words
    const long = Object.entries(v).filter(([k, x]) => typeof x === 'string' && x.trim().length >= 16 && /\s/.test(x.trim()) && !/(id|uuid|ref|hash|key|url|path)$/i.test(k))
    if (long.length) { const [k, x] = long.reduce((a, b) => (b[1].length > a[1].length ? b : a)); wordKey = k; words = oneLine(x) }
  }
  const metaKeys = [...fields.filter(f => f !== wordKey), ...META_KEYS.filter(k => !fields.includes(k))]
  const meta = []
  for (const k of metaKeys) {
    if (meta.length >= 3) break
    const x = v[k]
    if (k === wordKey || x == null || x === '' || typeof x === 'object') continue
    const s = oneLine(x)
    if (s.length > 40) continue
    meta.push(typeof x === 'number' || /^(step|epoch|rev|line|run)$/.test(k) ? `${k} ${typeof x === 'number' ? (/^(step|epoch|rev|line)$/.test(k) ? String(x) : n(x)) : s}` : s)
  }
  if (!words) {
    // nothing reads as words: the short fields themselves, as a row reads
    const short = Object.entries(v).filter(([k, x]) => k !== '_rows' && x != null && typeof x !== 'object').slice(0, 4)
    words = short.map(([k, x]) => `${k} ${typeof x === 'number' ? n(x) : oneLine(x)}`).join(' · ')
    return { words, meta: where }
  }
  if (where) meta.push(where)
  return { words, meta: meta.join(' · ') }
}

/** Whether records read best as a table: flat rows of a few short fields that a person reads as they are (a run's
 *  steps, a sweep's epochs). Rows that carry ids (a wiki revision's rev_id and page_id) read as their words instead. */
export function asTable(records) {
  const rs = (records || []).filter(r => r && typeof r === 'object' && !Array.isArray(r))
  if (!rs.length || rs.length !== records.length) return false
  // rows the kernel read back ({ref, words, meta}, a label's examples) read as their words, however short
  if (rs.every(r => typeof r.ref === 'string' && (r.words != null || r.text != null) && r.value === undefined)) return false
  const keys = [...new Set(rs.flatMap(r => Object.keys(r)))].filter(k => k !== '_rows' && k !== 'ref')
  if (!keys.length || keys.length > 6 || keys.some(k => /(^|_)(id|uuid|hash|key)$/i.test(k))) return false
  return rs.every(r => keys.every(k => r[k] == null || (typeof r[k] !== 'object' && String(r[k]).length <= 120)))
}

/** The columns of a table of records: short fields first, the field with the most words last. */
export function tableCols(records) {
  const keys = [...new Set(records.flatMap(r => Object.keys(r || {})))].filter(k => k !== '_rows' && k !== 'ref')
  const len = k => Math.max(...records.map(r => String(r?.[k] ?? '').length))
  return keys.sort((a, b) => (len(a) > 40) - (len(b) > 40))
}

/**
 * How an examples set reads in `fit` rows around the current record `at`:
 *   {kind: 'table', cols, rows: [{rec, i, on}]}           flat records (a run's steps)
 *   {kind: 'lines', rows: [{words, meta, i, on}]}         records with words: two lines each
 * `fmt` (k.examples) wins when the program gave one: its first line is the words, its second the meta.
 */
export function examplesView(records, o = {}) {
  const recs = records || []
  const total = recs.length
  const at = total ? (((Number(o.at) || 0) % total) + total) % total : 0
  const fit = Math.max(1, o.fit || 6)
  if (!o.fmt && asTable(recs)) {
    const shown = Math.max(1, fit - 1)
    const from = Math.max(0, Math.min(at - 2, total - shown))
    return { kind: 'table', cols: tableCols(recs), at, rows: recs.slice(from, from + shown).map((rec, j) => ({ rec, i: from + j, on: from + j === at })) }
  }
  const per = 2
  const shown = Math.max(1, Math.floor(fit / per))
  const from = Math.max(0, Math.min(at - 1, total - shown))
  return {
    kind: 'lines', at,
    rows: recs.slice(from, from + shown).map((rec, j) => {
      const w = o.fmt && rec && typeof rec === 'object' ? fmtWords(o.fmt, rec) : recordWords(rec, { fields: o.fields })
      return { ...w, i: from + j, on: from + j === at }
    }),
  }
}

const RAWK = /(^|_)(id|rev|step|epoch|run|ref|line|seq)$/i

/** A record through the program's `fmt` ('“{text}”\n{user} · {page}'): its first line the words, the second its meta. */
export function fmtWords(fmt, rec) {
  const s = String(fmt).replace(/\{([\w.]+)\}/g, (m, key) => {
    const v = key.split('.').reduce((x, k) => (x == null ? undefined : x[k]), rec)
    if (v === undefined) return m
    return typeof v === 'number' && !RAWK.test(key) && Math.abs(v) >= 1000 ? n(v) : String(v)
  }).replace(/\*\*([^*]+)\*\*/g, '$1')
  const [a, ...b] = s.split('\n')
  return { words: oneLine(a), meta: oneLine(b.join(' · ')) }
}

// ---------------------------------------------------------------------------------------------- the "from" line

/**
 * The "from" line as segments [{t, tone?, bold?}]: where the part's rows are (the source file), how many rows it uses,
 * the labels it uses, and how much of the data was read.
 *   facts: {sources: [{path, rows}], rows, labels, coverage: {feeding, files}} (fromFacts)
 *   o: {rows: the selected part's own row count, source: its own source file, labels: its own labels}
 */
export function fromLine(facts, o = {}) {
  const f = facts || {}
  const sources = (f.sources || []).map(s => s.path).filter(Boolean)
  const source = o.source || sources[0] || ''
  const more = o.source ? 0 : Math.max(0, sources.length - 1)
  const seg = []
  const dot = () => seg.push({ t: ' · ', tone: 'unseen' })
  seg.push({ t: 'from ', tone: 'dim' })
  seg.push({ t: source || 'no source rows', bold: !!source })
  if (more) seg.push({ t: ` +${more} more`, tone: 'dim' })
  const rows = o.rows != null ? o.rows : f.rows
  if (rows != null && rows !== 0) { dot(); seg.push({ t: `${n(rows)} row${rows === 1 ? '' : 's'}` }) }
  const labels = o.labels || f.labels || []
  if (labels.length) { dot(); seg.push({ t: `label${labels.length === 1 ? '' : 's'} ${labels.join(', ')}`, tone: 'dim' }) }
  const c = f.coverage
  if (c && c.files) {
    dot()
    const all = c.feeding >= c.files
    seg.push({ t: all ? '' : '░ ', tone: 'unseen' })
    seg.push({ t: all ? `all ${n(c.files)} file${c.files === 1 ? '' : 's'} read` : `${n(c.feeding)} of ${n(c.files)} files read`, tone: all ? 'dim' : 'warn' })
  }
  return seg
}

// ---------------------------------------------------------------------------------------------- the program behind p

/** The program's lines that name the part: its id, else its id's stem (`day-` of `day-2026-06-18`), else the lines
 *  that make regions. 1-based. */
export function programLines(program, id) {
  const lines = String(program || '').split('\n')
  const hit = new Set()
  if (!id) return hit
  const find = t => lines.forEach((l, i) => { if (l.includes(t)) hit.add(i + 1) })
  find(id)
  // the id's stem, shorter and shorter: `day-2026-06-` then `day-2026-` then `day-`
  let stem = String(id)
  while (!hit.size) {
    const m = /^(.*[-_.:])[^-_.:]*$/.exec(stem.replace(/[-_.:]$/, ''))
    if (!m || m[1].length < 3) break
    stem = m[1]
    find(stem)
  }
  if (!hit.size) for (const t of ['region(', 'bars(', 'table(', 'map(']) { find(t); if (hit.size) break }
  return hit
}

// ---------------------------------------------------------------------------------------------- Claude's words

const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g

/** Claude's words as runs: plain text, and each citation's words with its target. `**bold**` is kept as bold runs. */
export function linkRuns(text) {
  const s = String(text || '')
  const out = []
  let last = 0
  for (const m of s.matchAll(LINK)) {
    if (m.index > last) out.push(...boldRuns(s.slice(last, m.index)))
    out.push({ s: m[1].replace(/\*\*/g, ''), link: m[2] })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(...boldRuns(s.slice(last)))
  return out
}

function boldRuns(s) {
  const out = []
  s.split(/(\*\*[^*]+\*\*)/).forEach(p => { if (p) out.push(p.startsWith('**') && p.endsWith('**') && p.length > 4 ? { s: p.slice(2, -2), bold: true } : { s: p }) })
  return out
}

/** The part a citation of the takeaway selects: `#id` names a part, a kernel ref selects the part that rests on it. */
export function partOfLink(link, parts, refsOf) {
  if (!link) return null
  if (link.startsWith('#')) return parts.some(p => p.id === link.slice(1)) ? link.slice(1) : null
  for (const p of parts) if ((refsOf(p.id) || []).includes(link)) return p.id
  return null
}
