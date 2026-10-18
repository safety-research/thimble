// chips.mjs: Squeeze as chips under a message. No `$`, no Node, no DOM: the hooks module (term.ts), the verb's run.mjs
// and the tests import it.
//
// The chips are the same for every message; only where the original stands on each differs:
//   Length              one line · short · medium · full. The original is always at full.
//   Report ↔ Interpret  report · both · interpret: just the facts, listed, or the story of what they mean.
//   Familiarity         new · familiar · expert: how much of the field and the work the text assumes.
//   the person's own    a chip in their own words ("for my manager"), sized by the same call that writes it: its levels
//                       go from "off" (it changes nothing) to its strongest.
// The observer says where the original stands on Report ↔ Interpret and Familiarity (record.verbs.s.at); until it
// has, each stands in its middle. Every chip counts in every rewrite: one $.model.complete call writes the message at
// all the chips' levels at once.
//
// The record keeps it (CONTRACT 1, beside `shown`):
//   squeeze: {
//     at:       {chipId: level}       the levels set now; a chip not named stands where the original does
//     own:      [{id, name, words, levels}]   the person's chips (levels [] until the call sized them)
//     versions: {key: text}           every version written, by its levels, so a level seen before comes back at once
//     orig:     {marks}               the original's marks, so a sparkline's values outlive a version that dropped it
//     auto:     true                  it arrived squeezed (a long message)
//     problems: ['...']              what a rewrite said that the original does not (a number, a ref): shown, not hidden
//     made:     [{key, ms, model, usage}]   each call, for its time and cost
//   }
// `shown` holds the text at `at` (null at the original); the marks are placed again on it (shell/message.js remark).

/** The chips every message has, in the order drawn. `level0` is where the original stands until the observer says. */
export const CHIPS = Object.freeze([
  Object.freeze({ id: 'length', name: 'Length', levels: Object.freeze(['one line', 'short', 'medium', 'full']), level0: 3, style: 'dots', kind: 'fixed' }),
  Object.freeze({ id: 'interpret', name: 'Report ↔ Interpret', levels: Object.freeze(['report', 'both', 'interpret']), level0: 1, style: 'pos', kind: 'fixed' }),
  Object.freeze({ id: 'familiarity', name: 'Familiarity', levels: Object.freeze(['new', 'familiar', 'expert']), level0: 1, style: 'dots', kind: 'fixed' }),
])
export const LENGTH = CHIPS[0]
/** The level of Length a long message arrives at: short. */
export const ARRIVE = 1
const MAX_OWN = 3

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s)
const sq = rec => (rec && rec.squeeze && typeof rec.squeeze === 'object' ? rec.squeeze : {})

/** The dots of a chip at level v: ●●○○ counts up for Length and Familiarity, ○●○ marks a place between two ends,
 *  and a chip of the person's fills from none (○○ off, ●○ plain, ●● status). */
export function glyph(chip, v) {
  const n = chip.levels.length
  const lv = Math.max(0, Math.min(n - 1, v))
  const style = chip.kind === 'own' ? 'fill' : chip.style
  if (style === 'pos') return Array.from({ length: n }, (_, i) => (i === lv ? '●' : '○')).join('')
  if (style === 'fill') return '●'.repeat(lv) + '○'.repeat(n - 1 - lv)
  return '●'.repeat(lv + 1) + '○'.repeat(n - 1 - lv)
}

/** Where the observer says the original stands on a fixed chip (record.verbs.s.at: a level's name or index), or null. */
function observed(rec, chip) {
  const at = rec?.verbs?.s?.at
  if (!at || typeof at !== 'object' || chip.id === LENGTH.id) return null
  const v = at[chip.id]
  if (Number.isInteger(v) && v >= 0 && v < chip.levels.length) return v
  if (typeof v === 'string') {
    const i = chip.levels.indexOf(v.trim().toLowerCase())
    if (i >= 0) return i
  }
  return null
}

/** Every chip of the message, in the order drawn: the fixed three, then the person's. Each with `level0`, where the
 *  original stands (`known` once the observer said so), and `level`, where it is now. */
export function chipsOf(rec) {
  const s = sq(rec)
  const at = s.at && typeof s.at === 'object' ? s.at : {}
  const fixed = CHIPS.map(c => {
    const o = observed(rec, c)
    return { ...c, levels: [...c.levels], level0: o ?? c.level0, known: c.id === LENGTH.id || o != null }
  })
  const own = (Array.isArray(s.own) ? s.own : []).map(c => ({ id: c.id, name: c.name, words: c.words, levels: Array.isArray(c.levels) ? c.levels : [], level0: 0, kind: 'own', known: true }))
  return [...fixed, ...own].map(c => {
    const want = at[c.id]
    const level = Number.isInteger(want) && want >= 0 && want < Math.max(1, c.levels.length) ? want : c.level0
    return { ...c, level }
  })
}

/** The levels that differ from the original, as one key: the same key, the same version. A chip at the original's
 *  level is "as the original", so a version keeps its key when the observer later says where the original stands. */
export function keyOf(chips) {
  return chips.filter(c => c.levels.length && c.level !== c.level0).map(c => `${c.id}=${c.level}`).join('&')
}

/** Whether every chip stands where the original does: then the original shows. */
export const isOriginal = chips => chips.every(c => c.level === c.level0)

/** The record's `at` after one chip moved by `dir` (-1, +1), or null when it is already at that end. */
export function stepAt(rec, id, dir) {
  const chip = chipsOf(rec).find(c => c.id === id)
  if (!chip || !chip.levels.length) return null
  const to = chip.level + dir
  if (to < 0 || to >= chip.levels.length) return null
  return { ...(sq(rec).at || {}), [id]: to }
}

/** A chip of the person's, from their words: its name is their words, its levels come with the call that writes it. */
export function ownChip(rec, words) {
  const w = str(String(words || '').replace(/^\+\s*/, ''), 60)
  if (!w) return null
  const used = new Set(chipsOf(rec).map(c => c.id))
  let id = `my-${slug(w) || 'chip'}`.slice(0, 24)
  for (let i = 2; used.has(id); i++) id = `${id.slice(0, 20)}-${i}`
  return { id, name: cap(w.length > 22 ? w.slice(0, 21).replace(/\s+\S*$/, '') + '…' : w), words: w, levels: [], level0: 0 }
}

/** The record's squeeze with a chip of the person's added (the oldest of more than three goes). */
export function withOwn(rec, chip) {
  const s = sq(rec)
  const own = [...(Array.isArray(s.own) ? s.own : []).filter(c => c.id !== chip.id), chip]
  const gone = own.length > MAX_OWN ? own.shift() : null
  const at = { ...(s.at || {}) }
  if (gone) delete at[gone.id]
  return { ...s, own, at }
}

// ------------------------------------------------------------------------------------------------ how long it is

/** The rows a text takes at `cols` columns, as drawn: each line wrapped at spaces, a link as its words, a blank line one
 *  row. Close to what the terminal draws, which is what "6 of 33 lines" counts. */
export function rowsOf(text, cols = 100) {
  const w = Math.max(20, cols)
  let n = 0
  for (const raw of String(text || '').replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1').replace(/\*\*|`/g, '').split('\n')) {
    if (!raw.trim()) { n++; continue }
    let len = 0
    let rows = 1
    for (const word of raw.trim().split(/\s+/)) {
      const l = [...word].length
      if (len && len + 1 + l > w) { rows++; len = l } else len += (len ? 1 : 0) + l
    }
    n += rows
  }
  return n
}

/**
 * Whether a message should arrive squeezed: it takes more rows than `room`, half the screen (26 rows of a 48-row
 * terminal), the most an object under a reply takes before the rest waits in its detail view. In past sessions the
 * observer found every answer of 17 lines or more long enough to squeeze; at 100 columns those take 29 to 50 rows.
 */
export function isLong(text, { cols = 100, room = 26 } = {}) {
  return rowsOf(text, cols) > Math.max(16, room)
}

// ------------------------------------------------------------------------------------------------ the call

/** The words of a message as the person reads them: a citation counts its words, not its ref. */
export function wordsOf(text) {
  return String(text || '').replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
}

/** What a level of Length means for this message, in words: the model keeps a number better than a level's name. */
export function lengthTarget(level, words) {
  if (level === 0) return 'one sentence, at most 35 words'
  // a quarter and a half of the original, but never longer than most of a short message, and short stays short
  const round = n => (n >= 40 ? Math.round(n / 5) * 5 : Math.max(1, Math.round(n)))
  if (level === 1) return `at most ${round(Math.min(120, Math.max(Math.min(30, words * 0.6), words * 0.25)))} words`
  if (level === 2) return `at most ${round(Math.max(words * 0.5, Math.min(50, words * 0.8)))} words`
  return `about ${words} words, as the original`
}

/** One chip as the request names it. */
function chipLine(c, newOwn, words = 0) {
  if (newOwn && c.id === newOwn.id) return null
  const levels = c.levels.join(' · ')
  if (c.id === 'length' && words) return `- ${c.name}: ${c.levels[c.level]}, ${lengthTarget(c.level, words)} (levels ${levels}; the original is at full, ${words} words)`
  if (c.kind === 'own') return `- ${c.name}: ${c.levels[c.level]} (the person's own chip, "${c.words}"; levels ${levels}; "${c.levels[0]}" changes nothing)`
  // where nobody has said where the original stands, a chip the person left alone keeps the original as it is
  if (!c.known && c.level === c.level0) return `- ${c.name}: as the original (levels ${levels})`
  return `- ${c.name}: ${c.levels[c.level]} (levels ${levels}; the original is at ${c.known ? c.levels[c.level0] : 'a level not yet known'})`
}

/**
 * The $.model.complete request that writes the message at its chips' levels. `system` is prompt.md's text. With
 * `newOwn` (a chip the person just typed), the call also gives that chip its levels and picks one.
 * The fixed text goes first and is marked for the prompt cache: prompt.md, then the question and the original, so a
 * second change of the same message reads them from the cache.
 */
/** @param {any} rec @param {{system?: string, question?: string, chips?: any[], newOwn?: any, model?: string, effort?: string, maxTokens?: number, timeoutMs?: number}} [opts] */
export function request(rec, { system, question = '', chips = chipsOf(rec), newOwn = null, model = 'sonnet', effort = 'low', maxTokens = 4000, timeoutMs = 90000 } = {}) {
  const head = [
    question ? `The person asked: ${question.trim().slice(0, 2000)}` : 'The person\'s question is not known.',
    '',
    'Claude\'s message, as written (the original):',
    '<original>',
    String(rec?.text ?? ''),
    '</original>',
  ].join('\n')
  const words = wordsOf(rec?.text)
  const lines = chips.map(c => chipLine(c, newOwn, words)).filter(Boolean)
  const tail = ['', 'The chips, each at the level to write now:', ...lines]
  if (newOwn) tail.push('', `The person added a chip in their own words: "${newOwn.words}". Give it its levels, pick the level their words ask for, and write the message at it, with the other chips as set.`)
  tail.push('', 'Write the message at these levels.')
  return {
    model, effort, maxTokens, timeoutMs,
    system: [{ text: String(system || ''), cache: true }],
    prompt: [{ text: head, cache: true }, { text: tail.join('\n') }],
  }
}

/** A level's name as a tile shows it: at most 20 characters, cut after a whole word. */
function shortName(x) {
  const t = str(x, 80)
  if (t.length <= 20) return t
  const cut = t.slice(0, 21).replace(/\s+\S*$/, '')
  return cut || t.slice(0, 20)
}

/** The reply: the text in <text> tags, and a new chip's levels and pick when it gave them. */
export function readReply(raw) {
  const s = String(raw || '')
  const t = /<text>\s*\n?([\s\S]*?)\n?\s*<\/text>/i.exec(s)
  let text = t ? t[1] : s.replace(/<chip\b[^>]*\/?>/gi, '')
  text = text.replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim()
  let chip = null
  const c = /<chip\b([^>]*)\/?>/i.exec(s)
  if (c) {
    const attr = name => (new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(c[1]) || [])[1] || ''
    const levels = attr('levels').split(/\s*[|·]\s*/).map(x => shortName(x)).filter(Boolean).slice(0, 4)
    if (levels.length >= 2) {
      const pick = attr('pick').trim().toLowerCase()
      let level = levels.findIndex(l => l.toLowerCase() === pick)
      if (level < 0) level = Number.isInteger(Number(pick)) && Number(pick) > 0 && Number(pick) < levels.length ? Number(pick) : levels.length - 1
      chip = { levels, level: Math.max(1, level) }
    }
  }
  return { text, chip }
}

const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
const norm = s => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1')
const numbersIn = s => (norm(String(s).replace(LINK, '$1 $2')).match(/\d+(?:\.\d+)?/g) || []).filter(n => n.length > 1 || Number(n) > 9)

/**
 * A rewrite held to the original: a link to a ref the original never cited loses its link (its words stay), and a
 * number the original never states is named as a problem. Returns the text to show and the problems.
 */
export function checkRewrite(original, text) {
  const refs = new Set([...String(original).matchAll(LINK)].map(m => m[2].trim()))
  const problems = []
  const out = String(text).replace(LINK, (whole, words, ref) => {
    if (refs.has(ref.trim()) || /^(https?|mailto):/i.test(ref)) return whole
    problems.push(`a citation to ${ref.trim().slice(0, 60)} is not in the original, so it shows as plain words`)
    return words
  })
  const have = new Set(numbersIn(original))
  const stray = [...new Set(numbersIn(out.replace(LINK, '$1')).filter(n => !have.has(n)))]
  if (stray.length) problems.push(`${stray.slice(0, 3).map(n => `"${n}"`).join(', ')} ${stray.length === 1 ? 'is' : 'are'} not in the original`)
  return { text: out, problems }
}

// ------------------------------------------------------------------------------------------------ the record

/**
 * The record after a rewrite came back: `shown` is the new text, the squeeze state is at `at`, a chip of the person's
 * gets the levels the call gave it, and the version is kept. `remark` (shell/message.js) places the marks again; it is
 * passed in so this file needs no import. `made` is the call's {ms, model, usage}.
 */
/** @param {any} rec @param {{text: string, at: Record<string, number>, newOwn?: any, chip?: any, made?: any, problems?: string[]}} change @param {(r: any) => any} remark */
export function applyRewrite(rec, { text, at, newOwn = null, chip = null, made = null, problems = [] }, remark) {
  const s0 = sq(rec)
  let s = { ...s0, at: { ...at }, versions: { ...(s0.versions || {}) }, orig: s0.orig || { marks: (rec.shown == null ? rec.marks : []) || [] } }
  if (newOwn) {
    const own = (s.own || []).map(c => (c.id === newOwn.id ? { ...c, levels: chip ? chip.levels : ['off', 'on'] } : c))
    s = { ...s, own, at: { ...s.at, [newOwn.id]: chip ? chip.level : 1 } }
  }
  const probe = { ...rec, squeeze: s }
  const chips = chipsOf(probe)
  const key = keyOf(chips)
  s.versions[key] = text
  s.problems = problems
  if (made) s.made = [...(s0.made || []), { key, ...made }].slice(-20)
  const prev = [...(rec.marks || []), ...((s.orig && s.orig.marks) || [])]
  const next = isOriginal(chips) ? { ...rec, shown: null, squeeze: s } : { ...rec, shown: text, squeeze: s }
  return remark({ ...next, marks: prev })
}

/** The record at a set of levels already written (a level seen before): no call. Null when that version is not kept. */
export function fromVersions(rec, at, remark) {
  const s = sq(rec)
  const chips = chipsOf({ ...rec, squeeze: { ...s, at } })
  if (isOriginal(chips)) return restore({ ...rec, squeeze: { ...s, at } }, remark)
  const text = (s.versions || {})[keyOf(chips)]
  if (typeof text !== 'string') return null
  const prev = [...(rec.marks || []), ...((s.orig && s.orig.marks) || [])]
  return remark({ ...rec, shown: text, squeeze: { ...s, at, problems: [] }, marks: prev })
}

/** The original again: every chip back where the original stands, the person's chips kept (off). */
export function restore(rec, remark) {
  const s = sq(rec)
  const prev = [...((s.orig && s.orig.marks) || []), ...(rec.marks || [])]
  return remark({ ...rec, shown: null, squeeze: { ...s, at: {}, problems: [] }, marks: prev })
}

/** What the verb row says of the message: `6 of 33 lines` while it is squeezed, `33 lines` for a long original. */
export function noteOf(rec, cols = 100) {
  const full = rowsOf(rec?.text, cols)
  if (rec && typeof rec.shown === 'string') return `${rowsOf(rec.shown, cols)} of ${full} lines`
  return `${full} lines`
}

/** What Claude reads, with the person's next prompt, of the version they see. */
export function noteFor(rec) {
  const chips = chipsOf(rec)
  if (isOriginal(chips)) return 'The person restored your last reply as you wrote it.'
  const set = chips.filter(c => c.level !== c.level0).map(c => `${c.name}: ${c.levels[c.level]}`).join(', ')
  return `The person reads your last reply rewritten by the squeeze chips (${set}); what you wrote is unchanged, and they can restore it. "This" may mean the version they read:\n${String(rec.shown || '').slice(0, 1500)}`
}
