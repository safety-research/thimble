// chips.mjs: Squeeze as chips under a message. No `$`, no Node, no DOM: the hooks module (term.ts), the verb's run.mjs
// and the tests import it.
//
// The chips are the same for every message; only where the original stands on each differs:
//   Length              one line · short · medium · full. The original is always at full.
//   Report ↔ Interpret  report · balanced · interpret: the facts and counts alone, or the story of what they mean
//                       with its judgment calls. The two ends share almost no sentences.
//   Familiarity         new to the field · beginner · working · fluent · expert: how much of the field the text
//                       assumes. New explains each term where it stands; expert reads like a commit message.
//   a stretch           between two ends the person types after +, such as "engineer and manager": the original
//                       stands at the first end (0), and each of 3 steps moves the text toward the second.
// The observer says where the original stands on Report ↔ Interpret and Familiarity (record.verbs.s.at); until it
// has, each stands in its middle. Every chip counts in every rewrite: one $.model.complete call writes the message at
// all the chips' levels at once, and each version written is kept, so a state seen before comes back with no call.
//
// The record keeps it (CONTRACT 1, beside `shown`):
//   squeeze: {
//     at:       {chipId: level}       the levels set now; a chip not named stands where the original does
//     own:      [{id, kind: 'stretch', from, to, name, levels}]   the person's stretches
//     versions: {key: text}           every version written, by its levels, so a state seen before comes back at once
//     orig:     {marks}               the original's marks, so a sparkline's values outlive a version that dropped it
//     auto:     true                  it arrived squeezed (a long message)
//     problems: ['...']              what a rewrite said that the original does not (a number, a ref): shown, not hidden
//     made:     [{key, ms, model, usage}]   each call, for its time and cost
//   }
// `shown` holds the text at `at` (null at the original); the marks are placed again on it (shell/message.js remark).

/** The chips every message has, in the order drawn. `level0` is where the original stands until the observer says. */
export const CHIPS = Object.freeze([
  Object.freeze({ id: 'length', name: 'Length', levels: Object.freeze(['one line', 'short', 'medium', 'full']), level0: 3, kind: 'fixed' }),
  Object.freeze({ id: 'interpret', name: 'Report ↔ Interpret', levels: Object.freeze(['report', 'balanced', 'interpret']), level0: 1, kind: 'fixed' }),
  Object.freeze({ id: 'familiarity', name: 'Familiarity', levels: Object.freeze(['new to the field', 'beginner', 'working', 'fluent', 'expert']), level0: 2, kind: 'fixed' }),
])
export const LENGTH = CHIPS[0]
/** The level of Length a long message arrives at: short. */
export const ARRIVE = 1
/** The steps of a stretch: 0 is the original, at its first end; 3 is all the way to its second end. */
export const STRETCH_STEPS = 3
const MAX_OWN = 3
// the names an observer or an older record may give a level, as the levels are named now
const ALIAS = { interpret: { both: 1, story: 2, facts: 0 }, familiarity: { new: 0, newcomer: 0, novice: 0, familiar: 2, intermediate: 2, 'new to testing': 0 } }

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
const sq = rec => (rec && rec.squeeze && typeof rec.squeeze === 'object' ? rec.squeeze : {})

/** The dots of a chip at level v: one ● at its place among ○, as `○●○○` for Length short. */
export function glyph(chip, v) {
  const n = Math.max(1, chip.levels.length)
  const lv = Math.max(0, Math.min(n - 1, v))
  return Array.from({ length: n }, (_, i) => (i === lv ? '●' : '○')).join('')
}

/** A level's index from its name (or an alias, or an index), or null. */
function levelOf(chip, v) {
  if (Number.isInteger(v) && v >= 0 && v < chip.levels.length) return v
  if (typeof v !== 'string') return null
  const w = v.trim().toLowerCase()
  const i = chip.levels.indexOf(w)
  if (i >= 0) return i
  const a = (ALIAS[chip.id] || {})[w]
  return Number.isInteger(a) ? a : null
}

/** Where the observer says the original stands on a fixed chip (record.verbs.s.at: a level's name or index), or null. */
function observed(rec, chip) {
  const at = rec?.verbs?.s?.at
  if (!at || typeof at !== 'object' || chip.id === LENGTH.id) return null
  return levelOf(chip, at[chip.id])
}

/** A stretch as a chip: its levels are its steps, the first end at 0 (the original) and the second at the last. */
function stretchOf(c) {
  const from = str(c.from, 40) || 'as written'
  const to = str(c.to, 40) || str(c.words, 40) || 'other end'
  const levels = Array.from({ length: STRETCH_STEPS + 1 }, (_, i) => (i === 0 ? from : i === STRETCH_STEPS ? to : `${i} of ${STRETCH_STEPS} toward ${to}`))
  return { id: c.id, kind: 'stretch', from, to, name: `${from} ↔ ${to}`, levels, level0: 0, known: true }
}

/** Every chip of the message, in the order drawn: the fixed three, then the person's stretches. Each with `level0`,
 *  where the original stands (`known` once the observer said so), and `level`, where it is now. */
export function chipsOf(rec) {
  const s = sq(rec)
  const at = s.at && typeof s.at === 'object' ? s.at : {}
  const fixed = CHIPS.map(c => {
    const o = observed(rec, c)
    return { ...c, levels: [...c.levels], level0: o ?? c.level0, known: c.id === LENGTH.id || o != null }
  })
  const own = (Array.isArray(s.own) ? s.own : []).filter(c => c && c.id).map(stretchOf)
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

/**
 * The two ends the person typed after the +: "engineer and manager", "engineer ↔ manager", "engineer to manager",
 * "between novice and expert". One phrase alone ("for my manager") is a stretch from the text as written to it.
 * Returns {from, to} or null when nothing was typed.
 */
export function endsOf(words) {
  let w = String(words || '').replace(/^\s*\+\s*/, '').replace(/\s+/g, ' ').trim()
  w = w.replace(/^(stretch\s+)?(between|from)\s+/i, '')
  if (!w) return null
  const m = /^(.+?)\s*(?:↔|<->|<>|\/|\s(?:and|to|vs\.?|versus|-|–|—)\s)\s*(.+)$/i.exec(w)
  const cut = s => str(s, 40).replace(/[.,;:]+$/, '')
  if (m && cut(m[1]) && cut(m[2])) return { from: cut(m[1]), to: cut(m[2]) }
  return { from: 'as written', to: cut(w) }
}

/** A stretch of the person's, from what they typed after the +: no call is needed to make it, since it stands at the
 *  original until they step it. */
export function stretchChip(rec, words) {
  const ends = endsOf(words)
  if (!ends) return null
  const used = new Set(chipsOf(rec).map(c => c.id))
  let id = `x-${slug(`${ends.from === 'as written' ? '' : ends.from + '-'}${ends.to}`) || 'stretch'}`.slice(0, 24)
  for (let i = 2; used.has(id); i++) id = `${id.slice(0, 20)}-${i}`
  return { id, kind: 'stretch', from: ends.from, to: ends.to }
}

/** The record's squeeze with a stretch added (the oldest of more than three goes). */
export function withStretch(rec, chip) {
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

/** What a level of Length means for this message, in words: the model keeps a number better than a level's name. A
 *  correction the request lists does not count against it (`keep`: how many there are). */
export function lengthTarget(level, words, keep = 0) {
  if (level === 0) return keep ? `one sentence, at most 35 words, then each correction listed below in a few words` : 'one sentence, at most 35 words'
  // a quarter and a half of the original, but never longer than most of a short message, and short stays short
  const round = n => (n >= 40 ? Math.round(n / 5) * 5 : Math.max(1, Math.round(n)))
  if (level === 1) return `at most ${round(Math.min(120, Math.max(Math.min(30, words * 0.6), words * 0.25)))} words`
  if (level === 2) return `at most ${round(Math.max(words * 0.5, Math.min(50, words * 0.8)))} words`
  return `about ${words} words, as the original`
}

/** One chip as the request names it. */
function chipLine(c, words = 0, keep = 0) {
  const levels = c.levels.join(' · ')
  if (c.id === 'length' && words) return `- ${c.name}: ${c.levels[c.level]}, ${lengthTarget(c.level, words, keep)} (levels ${levels}; the original is at full, ${words} words)`
  if (c.kind === 'stretch') {
    const where = c.level === 0 ? `0 of ${STRETCH_STEPS}, as the original` : c.level === STRETCH_STEPS ? `${STRETCH_STEPS} of ${STRETCH_STEPS}, all the way to "${c.to}"` : `${c.level} of ${STRETCH_STEPS} steps toward "${c.to}"`
    return `- A stretch the person made, from "${c.from}" to "${c.to}": ${where} (the original stands at "${c.from}", step 0)`
  }
  // where nobody has said where the original stands, a chip the person left alone keeps the original as it is
  if (!c.known && c.level === c.level0) return `- ${c.name}: as the original (levels ${levels})`
  return `- ${c.name}: ${c.levels[c.level]} (levels ${levels}; the original is at ${c.known ? c.levels[c.level0] : 'a level not yet known'})`
}

/**
 * The $.model.complete request that writes the message at its chips' levels. `system` is prompt.md's text.
 * The fixed text goes first and is marked for the prompt cache: prompt.md, then the question and the original, so a
 * second change of the same message reads them from the cache.
 */
/** @param {any} rec @param {{system?: string, question?: string, chips?: any[], keep?: string[], terms?: string[], model?: string, effort?: string, maxTokens?: number, timeoutMs?: number}} [opts] */
export function request(rec, { system, question = '', chips = chipsOf(rec), keep = [], terms = [], model = 'sonnet', effort = 'low', maxTokens = 4000, timeoutMs = 90000 } = {}) {
  const head = [
    question ? `The person asked: ${question.trim().slice(0, 2000)}` : 'The person\'s question is not known.',
    '',
    'Claude\'s message, as written (the original):',
    '<original>',
    String(rec?.text ?? ''),
    '</original>',
  ].join('\n')
  const words = wordsOf(rec?.text)
  const lines = chips.map(c => chipLine(c, words, keep.length)).filter(Boolean)
  // the corrections in the original stay at every level, shortened if need be (mustKeep); the length does not count them
  const kept = keep.length ? ['', 'Corrections in the original. Each stays at every level, in as few words as it needs, next to what it corrects:', ...keep.map(k => `- ${k}`)] : []
  // the terms the person can open an explanation of (explain marks): kept in their own words where the text keeps them
  const named = terms.length ? ['', 'Terms the person can open an explanation of. Where your text keeps what a term names, use the term in these words:', ...terms.map(t => `- ${t}`)] : []
  const tail = ['', 'The chips, each at the level to write now:', ...lines, ...kept, ...named, '', 'Write the message at these levels.']
  return {
    model, effort, maxTokens, timeoutMs,
    system: [{ text: String(system || ''), cache: true }],
    prompt: [{ text: head, cache: true }, { text: tail.join('\n') }],
  }
}

/** The reply: the text in <text> tags, or the whole reply when it gave none (a code fence around it dropped). */
export function readReply(raw) {
  const s = String(raw || '')
  const t = /<text>\s*\n?([\s\S]*?)\n?\s*<\/text>/i.exec(s)
  const text = (t ? t[1] : s).replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim()
  return { text }
}

/** The terms of a record's explain marks (its glosses), for the rewrite to keep in their words: at most `max`. */
export function termsOf(rec, max = 8) {
  const out = []
  for (const g of Object.values((rec && rec.glosses) || {})) {
    const t = g && typeof g.term === 'string' ? g.term.replace(/\s+/g, ' ').trim() : ''
    if (t && t.length <= 80 && !out.includes(t)) out.push(t)
  }
  return out.slice(0, max)
}

// ------------------------------------------------------------------------------------------------ corrections kept

// a lead that says the words after it correct Claude's own earlier answer: "Two corrections to my last answer:",
// "**I also need to correct something I told you.**", "I miscounted earlier"
const OWN = /\b(correct(ion|ions|ing)?|wrong|mistake|misstated|overstated|understated|miscounted|mislabeled)\b[^.\n]*\b(my|I|earlier|last|previous|before|told you)\b|\b(I|my)\b[^.\n]*\b(correct(ion|ions)?|wrong|mistake|misstated|overstated|understated|miscounted|mislabeled)\b/i
// a sentence that sets an earlier statement right: "Earlier I said 5,181; it is 5,242."
const SAID = /\b(earlier|before|previously|last time|in my (last|earlier|previous) (answer|reply|message))\b[^.\n]*\b(I|we)\s+(said|wrote|reported|stated|counted|gave|claimed|called)\b|\b(I|we)\s+(said|wrote|reported|stated|counted|gave|claimed)\b[^.\n]*\b(earlier|before|last time|in my last)\b/i
const ITEM = /^\s*([-*+]|\d+[.)])\s+/
// an offer of more work, which only sounds like a correction ("I can check whether the answers were wrong")
const OFFER = /^\s*(\*\*)?(I can|I could|Want me|Do you want|If you (want|like)|Should I|Shall I)\b/i
const plainLine = t => String(t).replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1').replace(/[*_`]/g, '')

/**
 * The corrections of Claude's own earlier answer in a message, as the original writes them (markdown, links kept): a
 * list under a lead that says it corrects ("Two corrections to my last answer:") gives each item; a paragraph that
 * opens with such a lead is one; a sentence that sets an earlier statement right is one. `claims`: the session's claims
 * store, when the observer has read the message: a claim said in this message that revises one of Claude's earlier
 * claims adds the sentence that says it. At most `max`, each at most 600 characters.
 */
export function mustKeep(text, { claims = null, row = null, max = 4 } = {}) {
  const out = []
  const add = t => {
    const x = String(t || '').trim()
    if (!x || out.some(y => y === x || y.includes(x) || x.includes(y))) return
    out.push(x.length > 600 ? `${x.slice(0, 599)}…` : x)
  }
  const paras = String(text || '').split(/\n\s*\n/)
  for (const para of paras) {
    const lines = para.split('\n')
    const lead = lines.findIndex(l => !ITEM.test(l) && !OFFER.test(plainLine(l)) && OWN.test(plainLine(l).split(/(?<=[.!?])\s/)[0] || ''))
    if (lead >= 0 && /:\s*$/.test(plainLine(lines[lead]).trim())) {
      // a list under the lead: each item a correction
      const items = lines.slice(lead + 1).filter(l => ITEM.test(l)).map(l => l.replace(ITEM, ''))
      if (items.length) { items.forEach(add); continue }
    }
    if (lead === 0 && !ITEM.test(lines[0])) { add(para); continue }
    for (const sent of para.split(/(?<=[.!?])\s+(?=[A-Z*"(])/)) if (SAID.test(plainLine(sent)) && !OFFER.test(plainLine(sent))) add(sent)
  }
  if (claims && row) {
    const byId = new Map((claims.claims || []).map(c => [c.id, c]))
    for (const c of claims.claims || []) {
      if (!c.revises || c.by === 'person') continue
      const old = byId.get(c.revises)
      if (!old || old.by === 'person') continue
      const here = (c.said || []).find(p => p.row === row)
      if (here?.sentence) add(here.sentence)
    }
  }
  return out.slice(0, max)
}

/**
 * The corrections a rewrite left out, put back: one whose numbers (or, with none, most of its words) are not in the
 * rewrite is added after it, as the original says it. A correction may be shortened, never dropped. Returns the text
 * and the corrections put back.
 */
export function keepCorrections(text, keep) {
  const have = plainLine(text).toLowerCase()
  const nums = new Set(numbersIn(plainLine(text)))
  const back = []
  for (const k of keep || []) {
    const n = numbersIn(plainLine(k)).filter(x => x.length > 1)
    const words = plainLine(k).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []
    const kept = n.length ? n.some(x => nums.has(x)) : words.filter(w => have.includes(w)).length >= Math.ceil(words.length * 0.5)
    if (!kept) back.push(k)
  }
  return { text: back.length ? `${String(text).trimEnd()}\n\n${back.join('\n\n')}` : text, back }
}

const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
const norm = s => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1')
const numbersIn = s => (norm(String(s).replace(LINK, '$1 $2')).match(/\d+(?:\.\d+)?/g) || []).filter(n => n.length > 1 || Number(n) > 9)

/**
 * A rewrite held to the original: a link to a ref the original never cited loses its link (its words stay), and a
 * number the original never states is named as a problem. Returns the text to show and the problems.
 */
export function checkRewrite(original, text) {
  // each ref the original cites, with the numbers its words state there
  // the first number each cited ref's words state in the original: the value it cites (`13,403` of `13,403 of 14,591`)
  const cited = new Map()
  const wordsOf = new Map()
  for (const m of String(original).matchAll(LINK)) {
    const ref = m[2].trim()
    if (!cited.has(ref)) { cited.set(ref, new Set()); wordsOf.set(ref, m[1]) }
    const first = numbersIn(m[1])[0]
    if (first) cited.get(ref).add(first)
  }
  const problems = []
  const out = String(text).replace(LINK, (whole, words, ref) => {
    const r = ref.trim()
    if (/^(https?|mailto):/i.test(r)) return whole
    if (!cited.has(r)) {
      problems.push(`a citation to ${r.slice(0, 60)} is not in the original, so it shows as plain words`)
      return words
    }
    // a kept citation states the number the original cites there (it may add a date or a total beside it), never
    // only another number of the text
    const said = numbersIn(words)
    if (said.length && cited.get(r).size && !said.some(n => cited.get(r).has(n))) {
      problems.push(`"${words.slice(0, 40)}" was linked to the source of "${String(wordsOf.get(r)).slice(0, 40)}", so it shows as plain words`)
      return words
    }
    return whole
  })
  const have = new Set(numbersIn(original))
  const stray = [...new Set(numbersIn(out.replace(LINK, '$1')).filter(n => !have.has(n)))]
  if (stray.length) problems.push(`${stray.slice(0, 3).map(n => `"${n}"`).join(', ')} ${stray.length === 1 ? 'is' : 'are'} not in the original`)
  return { text: out, problems }
}

// ------------------------------------------------------------------------------------------------ the text writing in

/**
 * The first part of a text as it writes itself in from the top: at least `n` characters, cut where the markdown
 * still reads whole. The cut ends a word, never falls inside a link, inline code or bold, and takes a table's row or
 * a code fence whole. `n` past the end gives the whole text.
 */
export function revealCut(text, n) {
  const s = String(text || '')
  if (n >= s.length) return s
  let i = Math.max(0, Math.floor(n))
  // to the end of the word
  while (i < s.length && !/\s/.test(s[i])) i++
  const line0 = s.lastIndexOf('\n', i - 1) + 1
  const lineEnd = (k) => { const e = s.indexOf('\n', k); return e < 0 ? s.length : e }
  // a table's row, whole
  if (/^\s*\|/.test(s.slice(line0, lineEnd(line0)))) i = Math.max(i, lineEnd(line0))
  // a code fence, whole
  const fences = [...s.slice(0, i).matchAll(/^\s*```/gm)].length
  if (fences % 2) { const close = s.indexOf('```', i); i = close < 0 ? s.length : lineEnd(close) }
  // a link, inline code or bold left open on this line: on to where it closes
  for (let guard = 0; guard < 8 && i < s.length; guard++) {
    const line = s.slice(s.lastIndexOf('\n', i - 1) + 1, i)
    const ticks = (line.match(/`/g) || []).length
    const stars = (line.match(/\*\*/g) || []).length
    const openLink = /\[[^\]\n]*$|\]\([^)\n]*$/.test(line)
    if (ticks % 2) { const e = s.indexOf('`', i); i = e < 0 ? s.length : e + 1; continue }
    if (stars % 2) { const e = s.indexOf('**', i); i = e < 0 ? s.length : e + 2; continue }
    if (openLink) { const e = s.indexOf(')', i); i = e < 0 ? s.length : e + 1; continue }
    break
  }
  return s.slice(0, Math.min(s.length, i)).replace(/\s+$/, '')
}

/** How many characters to show at each tick of a text writing itself in: about 400 a second, the pace a model's
 *  stream reads at, and never more than about 2.5 s for the whole text. */
export function revealStep(total, tickMs = 50) {
  const perSec = Math.max(400, total / 2.5)
  return Math.max(8, Math.round(perSec * tickMs / 1000))
}

// ------------------------------------------------------------------------------------------------ the record

/**
 * The record after a rewrite came back: `shown` is the new text, the squeeze state is at `at`, and the version is kept.
 * `remark` (shell/message.js) places the marks again; it is passed in so this file needs no import. `made` is the
 * call's {ms, model, usage}.
 */
/** @param {any} rec @param {{text: string, at: Record<string, number>, made?: any, problems?: string[]}} change @param {(r: any) => any} remark */
export function applyRewrite(rec, { text, at, made = null, problems = [] }, remark) {
  const s0 = sq(rec)
  const s = { ...s0, at: { ...at }, versions: { ...(s0.versions || {}) }, orig: s0.orig || { marks: (rec.shown == null ? rec.marks : []) || [] } }
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
