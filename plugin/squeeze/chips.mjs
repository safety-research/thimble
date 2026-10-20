// chips.mjs: Squeeze as chips under a message. No `$`, no Node, no DOM: the hooks module (term.ts), the chips pane
// (panes/chips.js) and the tests import it.
//
// The chips are the same for every message; only where the original stands on each differs:
//   Length              one line · short · as written · longer · much longer. The original is always in the middle,
//                       "as written": shorter versions leave parts out, longer ones explain the same content more.
//   Interpretation      facts only · some meaning · full meaning: how much the text says about what the facts mean,
//                       from the facts alone to Claude's reading of them.
//   Background          new · learning · working · expert: the reader's background, how much of the field the text
//                       explains and how much it assumes.
//   a chip the person typed, after +: their own words ("for my manager", "more skeptical", "as a timeline",
//                       "engineer → manager"), as written · a little · more · fully. The original stands at as written.
// The observer says where the original stands on Interpretation and Background (record.verbs.s.at); until it
// has, each stands in its middle. A message arrives as Claude wrote it; the chips rewrite it on demand. A step on one
// of them made while that look runs waits for it, and then counts from the level it gives (rebaseAt; term.ts). Every
// chip counts in every rewrite: one $.model.complete call writes the message at all the chips' levels at once, and each
// version written is kept, so a state seen before comes back with no call.
//
// A catch-up is a message of its own that the chips write of several of Claude's messages: all of them since the
// person's last prompt, when replies piled up (shell/shell.tsx). Its record is a message's record with `catchup` set;
// its text (the original) is the messages as written, one after another (catchUpText); the request names them as
// several messages to write as one (CATCHUP_HEAD), and it arrives at Length short. Its original is the replies
// themselves, which stay in the transcript above it, so it never shows its original: 0 dismisses it, and the replies
// show again.
//
// The chips belong to the whole answer: its text and the cards drawn under it. With the squeeze switch for cards on,
// the request shows the original's cards and the query outputs they and the text draw on (cardsBlock), and a reply
// may edit a card (a new version of it, same id), add one, or leave one out (readCards). The term.ts side saves those
// through the kernel; here the record keeps which cards each version shows, so a version seen before, and the
// original, come back with their cards (cardListsAt).
//
// The record keeps it (CONTRACT 1, beside `shown`):
//   squeeze: {
//     at:       {chipId: level}       the levels set now; a chip not named stands where the original does
//     own:      [{id, words}]         the chips the person typed for this message (at most three)
//     scale:    3                     the chips' scales now: Length's original in its middle (records before scale 2
//                                     had one line · short · medium · full), Background's four levels (records before
//                                     scale 3 had five): levelsAt reads them
//     versions: {key: text}           every version written, by its levels, so a state seen before comes back at once
//     cards:    {key: {rows, did}}    the cards of each version that changed one: rows {row: [{id, v, root}]} as
//                                     drawn, did [{id, did: 'edited' | 'added' | 'left out', title, v}]
//     orig:     {marks, cards}        the original's marks, so a sparkline's values outlive a version that dropped it,
//                                     and its cards {row: [{id, v, root}]}, each at the version it had
//     auto:     true                  it arrived squeezed (a long message, in sessions before arrival squeezes ended)
//     problems: ['...']              what a rewrite said that the original does not (a number, a ref): shown, not hidden
//     made:     [{key, ms, model, usage}]   each call, for its time and cost
//   }
// `shown` holds the text at `at` (null at the original); the marks are placed again on it (shell/message.js remark).

/** The chips every message has, in the order drawn. `level0` is where the original stands until the observer says. */
export const CHIPS = Object.freeze([
  Object.freeze({ id: 'length', name: 'Length', levels: Object.freeze(['one line', 'short', 'as written', 'longer', 'much longer']), level0: 2, kind: 'fixed' }),
  // (the ids are the records' since before the chips were renamed; `key` is the name the observer gives each now)
  Object.freeze({ id: 'interpret', key: 'interpretation', name: 'Interpretation', levels: Object.freeze(['facts only', 'some meaning', 'full meaning']), level0: 1, kind: 'fixed' }),
  Object.freeze({ id: 'familiarity', key: 'background', name: 'Background', levels: Object.freeze(['new', 'learning', 'working', 'expert']), level0: 2, kind: 'fixed' }),
])
export const LENGTH = CHIPS[0]
/** The level of Length a catch-up arrives at: short. */
export const ARRIVE = 1
// the names an observer or an older record may give a level, as the levels are named now
const ALIAS = {
  interpret: { report: 0, balanced: 1, interpret: 2, both: 1, story: 2, facts: 0, 'facts alone': 0, reading: 2 },
  familiarity: { 'new to the field': 0, newcomer: 0, novice: 0, 'new to testing': 0, beginner: 1, familiar: 2, intermediate: 2, fluent: 3 },
}
/** The chips' scales now (the record's `scale`): Length's original in its middle, and Background's four levels. */
export const SCALE = 3

/** The levels of a chip the person typed: from the original (0) to all the way their words ask. */
export const OWN_LEVELS = Object.freeze(['as written', 'a little', 'more', 'fully'])
const MAX_OWN = 3

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const sq = rec => (rec && rec.squeeze && typeof rec.squeeze === 'object' ? rec.squeeze : {})

/** The dots of a chip at level v: one ● at its place among ○, as `○●○○○` for Length short. */
export function glyph(chip, v) {
  const n = Math.max(1, chip.levels.length)
  const lv = Math.max(0, Math.min(n - 1, v))
  return Array.from({ length: n }, (_, i) => (i === lv ? '●' : '○')).join('')
}

/** A chip's level in words: its name, and `as written` where the original stands (Length's middle is named so). A
 *  chip whose original level nobody has said yet reads `as written` at its start. */
export function levelWords(c) {
  const name = c.levels[c.level] || ''
  if (c.level !== c.level0) return name
  if (c.id === LENGTH.id || c.kind === 'own' || !c.known) return 'as written'
  return `${name}, as written`
}

/** The levels set away from the original, in words (`short · interpret`), or '' at the original. */
export function setWords(rec) {
  return chipsOf(rec).filter(c => c.level !== c.level0).map(c => c.levels[c.level]).join(' · ')
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
  return levelOf(chip, at[chip.key] ?? at[chip.id])
}

/** `at` as the chips' scales read it now. A record written before Length had its original in the middle (scale 2) had
 *  one line · short · medium · full with the original at full, so full is the original and medium reads as short; one
 *  written before Background had four levels (scale 3) had five, and its level reads as the original's. */
function levelsAt(s) {
  let at = s.at && typeof s.at === 'object' ? s.at : {}
  // (a record of before has versions written; a new one has none until its first rewrite, which sets the scale)
  const scale = Number(s.scale) || 1
  if (scale >= SCALE || !Object.keys(s.versions || {}).length) return at
  if (scale < 2 && Number.isInteger(at.length)) {
    const { length, ...rest } = at
    at = length >= 3 ? rest : { ...rest, length: Math.min(length, 1) }
  }
  if (Number.isInteger(at.familiarity)) {
    const { familiarity: _old, ...rest } = at
    at = rest
  }
  return at
}

/** The levels set now, as the chips' scales read them (a record from before is read as levelsAt says). */
export const atOf = rec => levelsAt(sq(rec))

/** A chip the person typed, as a chip: its words are its name, and its levels run from the original to fully. */
function ownChip(c) {
  return { id: c.id, kind: 'own', name: c.words, words: c.words, levels: [...OWN_LEVELS], level0: 0, known: true }
}

/** What the person typed after +, as a chip's words: one line, at most 40 characters, the + dropped. '' for none. */
export function ownWords(typed) {
  return str(String(typed || '').replace(/^\s*\+\s*/, ''), 40).replace(/[.,;:]+$/, '')
}

/** The record's squeeze with a chip the person typed added (or kept, when those words have one), its id, and the
 *  oldest of more than MAX_OWN gone. Null for empty words. */
export function withOwn(rec, typed) {
  const words = ownWords(typed)
  if (!words) return null
  const s = sq(rec)
  const own = (Array.isArray(s.own) ? s.own : []).filter(c => c && c.id)
  const have = own.find(c => c.words.toLowerCase() === words.toLowerCase())
  if (have) return { squeeze: s, id: have.id }
  const base = `x-${String(words).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'own'}`
  const used = new Set([...CHIPS.map(c => c.id), ...own.map(c => c.id)])
  let id = base
  for (let i = 2; used.has(id); i++) id = `${base.slice(0, 18)}-${i}`
  const next = [...own, { id, words }]
  const gone = next.length > MAX_OWN ? next.shift() : null
  const at = { ...(s.at || {}) }
  if (gone) delete at[gone.id]
  return { squeeze: { ...s, own: next, at }, id }
}

/** Every chip of the message, in the order drawn: the fixed three, then the ones the person typed. Each with `level0`,
 *  where the original stands (`known` once the observer said so), and `level`, where it is now. */
export function chipsOf(rec) {
  const s = sq(rec)
  const at = levelsAt(s)
  const fixed = CHIPS.map(c => {
    const o = observed(rec, c)
    return { ...c, levels: [...c.levels], level0: o ?? c.level0, known: c.id === LENGTH.id || o != null }
  })
  const own = (Array.isArray(s.own) ? s.own : []).filter(c => c && c.id && c.words).map(ownChip)
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
  return { ...levelsAt(sq(rec)), [id]: to }
}

/** The fixed chips other than Length that `at` moves while nobody has said where the original stands on them: such a
 *  step counts from the chip's middle until the observer gives the original's level. */
export function unplacedMoves(rec, at) {
  return chipsOf({ ...rec, squeeze: { ...sq(rec), at } }).filter(c => c.kind === 'fixed' && c.id !== LENGTH.id && !c.known && c.level !== c.level0).map(c => c.id)
}

/**
 * `at`, set on the record as it was before the observer said where the original stands (`before`), counted again from
 * where it says (`after`): each such chip keeps the steps the person made, now from the original's level, within the
 * chip's levels. A step from "balanced" (the middle) to "report" is one step toward report; when the original is at
 * "interpret", it becomes "balanced". A chip that comes back to the original's level is left out, as the original.
 */
export function rebaseAt(before, after, at) {
  const was = new Map(chipsOf({ ...before, squeeze: { ...sq(before), at: {} } }).map(c => [c.id, c]))
  const out = { ...(at || {}) }
  for (const c of chipsOf({ ...after, squeeze: { ...sq(after), at: {} } })) {
    const b = was.get(c.id)
    if (!b || c.kind !== 'fixed' || c.id === LENGTH.id || b.known || !c.known || !Number.isInteger(out[c.id])) continue
    const to = Math.max(0, Math.min(c.levels.length - 1, c.level0 + (out[c.id] - b.level0)))
    if (to === c.level0) delete out[c.id]
    else out[c.id] = to
  }
  return out
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

/** What a level of Length means for this message: a target the model aims for, set by the original's length (the
 *  model keeps a number better than a level's name). One line is what its name says, the main point in one sentence.
 *  Short is about a quarter of the original; longer and much longer are about one and a half and two and a half times
 *  it: room to explain, never to add. A correction the request lists does not count against it (`keep`: how many). */
export function lengthTarget(level, words, keep = 0) {
  if (level === 0) return keep ? 'one sentence with its main point, then each correction listed below in a few words' : 'one sentence with its main point'
  const round = n => (n >= 40 ? Math.round(n / 5) * 5 : Math.max(1, Math.round(n)))
  if (level === 1) return `about a quarter of the original, about ${round(words / 4)} words`
  if (level === 3) return `about one and a half times the original, about ${round(words * 1.5)} words`
  if (level === 4) return `about two and a half times the original, about ${round(words * 2.5)} words`
  return `about ${words} words, as the original`
}

/** One chip as the request names it. */
function chipLine(c, words = 0, keep = 0) {
  const levels = c.levels.join(' · ')
  if (c.id === 'length' && words) return `- ${c.name}: ${c.levels[c.level]}, ${lengthTarget(c.level, words, keep)} (levels ${levels}; the original is at "as written", ${words} words)`
  if (c.kind === 'own') return `- A chip the analyst typed, "${c.words}": ${c.levels[c.level]} (levels ${levels}; the original is at "as written")`
  // where nobody has said where the original stands, a chip the person left alone keeps the original as it is
  if (!c.known && c.level === c.level0) return `- ${c.name}: as the original (levels ${levels})`
  return `- ${c.name}: ${c.levels[c.level]} (levels ${levels}; the original is at ${c.known ? c.levels[c.level0] : 'a level not yet known'})`
}

/** The line that heads the original in a catch-up's request: several messages, written as one. */
export const CATCHUP_HEAD = "Claude's messages since the analyst's last prompt, in the order it wrote them, as written (the original). Write them as one message:"

/** A catch-up's original: Claude's messages, in order, one after another. */
export const catchUpText = texts => (texts || []).map(t => String(t || '').trim()).filter(Boolean).join('\n\n---\n\n')

/** Whether a record is a catch-up, and one that still stands (not dismissed). */
export const isCatchUp = rec => !!(rec && rec.catchup && typeof rec.catchup === 'object')
export const catchUpStands = rec => isCatchUp(rec) && !rec.catchup.dismissed

/**
 * The $.model.complete request that writes the message at its chips' levels. `system` is prompt.md's text, and
 * `toolkit` the card guide's toolkit, sent only with cards. The fixed text goes first and is marked for the prompt
 * cache: prompt.md, then the question, the original and its cards, so a second change of the same message reads them
 * from the cache.
 */
/** @param {any} rec @param {{system?: string, toolkit?: string, question?: string, chips?: any[], keep?: string[], terms?: string[], cards?: any[], outputs?: any[], model?: string, effort?: string, maxTokens?: number, timeoutMs?: number}} [opts] */
export function request(rec, { system, toolkit = '', question = '', chips = chipsOf(rec), keep = [], terms = [], cards = [], outputs = [], model = 'sonnet', effort = 'low', maxTokens = 4000, timeoutMs = 90000 } = {}) {
  const drawn = cardsBlock(cards, outputs)
  const head = [
    question ? `The analyst asked: ${question.trim().slice(0, 2000)}` : 'The analyst\'s question is not known.',
    '',
    isCatchUp(rec) ? CATCHUP_HEAD : 'Claude\'s message, as written (the original):',
    '<original>',
    String(rec?.text ?? ''),
    '</original>',
    ...(drawn ? ['', drawn] : []),
  ].join('\n')
  const words = wordsOf(rec?.text)
  const lines = chips.map(c => chipLine(c, words, keep.length)).filter(Boolean)
  // the corrections in the original stay at every level, shortened if need be (mustKeep); the length does not count them
  const kept = keep.length ? ['', 'Corrections in the original. Each stays at every level, in as few words as it needs, next to what it corrects:', ...keep.map(k => `- ${k}`)] : []
  // the terms the person can open an explanation of (explain marks): kept in their own words where the text keeps them
  const named = terms.length ? ['', 'Terms the analyst can open an explainer of. Where your text keeps what a term names, use the term in these words:', ...terms.map(t => `- ${t}`)] : []
  const tail = ['', 'The chips, each at the level to write now:', ...lines, ...kept, ...named, '', 'Write the message at these levels.']
  return {
    model, effort, maxTokens, timeoutMs,
    system: [{ text: String(system || ''), cache: true }, ...(drawn && toolkit ? [{ text: String(toolkit), cache: true }] : [])],
    prompt: [{ text: head, cache: true }, { text: tail.join('\n') }],
  }
}

/** The reply: the text in <text> tags, or the whole reply when it gave none (a code fence around it dropped, and any
 *  card blocks), and the card changes it asks for (readCards). */
export function readReply(raw) {
  const s = String(raw || '')
  const t = /<text>\s*\n?([\s\S]*?)\n?\s*<\/text>/i.exec(s)
  const text = (t ? t[1] : s.replace(CARD_BLOCK, '')).replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim()
  return { text, ...readCards(s) }
}

// ------------------------------------------------------------------------------------------------ the cards

/** A card change in a reply: `<card edit="ID">…</card>`, `<card add="name">…</card>` or `<card drop="ID"/>`. */
const CARD_BLOCK = /<card\s+(edit|add|drop)\s*=\s*"([^"]{1,80})"\s*(?:\/>|>([\s\S]*?)<\/card>)/gi
const FIELD = name => new RegExp(`<${name}>\\s*\\n?([\\s\\S]*?)\\n?\\s*</${name}>`, 'i')

/**
 * The card changes a reply asks for, in order: {op: 'edit' | 'add' | 'drop', id, title?, takeaway?, data?, program?},
 * each part only when given. A part that does not read (data that is no JSON object) is a problem, and its change is
 * left out. Returns {cards, cardProblems}.
 */
export function readCards(raw) {
  const cards = []
  const cardProblems = []
  for (const m of String(raw || '').matchAll(CARD_BLOCK)) {
    const op = m[1].toLowerCase()
    const id = m[2].trim()
    const body = m[3] || ''
    const c = { op, id }
    for (const [k, tag] of [['title', 'title'], ['takeaway', 'takeaway'], ['program', 'program']]) {
      const f = FIELD(tag).exec(body)
      if (f) c[k] = k === 'program' ? f[1].replace(/^\s*```(?:js|javascript)?\s*\n([\s\S]*?)\n```\s*$/i, '$1') : f[1].replace(/\s+/g, ' ').trim()
    }
    const d = FIELD('data').exec(body)
    if (d) {
      try {
        const v = JSON.parse(d[1])
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
        c.data = v
      } catch {
        cardProblems.push(`the change to card ${id} gave data that is no JSON object, so the card stays as it was`)
        continue
      }
    }
    if (op === 'add' && (!c.program || !c.data)) {
      cardProblems.push(`the new card ${id} came without ${!c.program ? 'a program' : 'its data'}, so it was not added`)
      continue
    }
    if (op === 'edit' && !['title', 'takeaway', 'program', 'data'].some(k => k in c)) continue
    cards.push(c)
  }
  return { cards, cardProblems }
}

/** A card as the request shows it: its id, its question as title, its takeaway, its data bindings and its program. */
function cardLines(c) {
  return [
    `<card id="${c.id}">`,
    `<title>${String(c.title || '').trim()}</title>`,
    `<takeaway>${String(c.text || '').trim()}</takeaway>`,
    `<data>${JSON.stringify(c.data ?? {})}</data>`,
    '<program>',
    String(c.program || '').trim(),
    '</program>',
    '</card>',
  ]
}

/**
 * The block of the request that shows the cards drawn under the original, in order, and the query outputs that they and
 * the original cite, as Claude read them when it ran each query: what a card may bind and draw. '' with neither.
 * `cards`: [{id, title, text, data, program}]; `outputs`: [{id, about, text}].
 */
export function cardsBlock(cards = [], outputs = []) {
  const out = []
  if (cards.length) out.push('The cards drawn under the original, in order:', ...cards.flatMap(cardLines))
  if (outputs.length) {
    if (out.length) out.push('')
    out.push('The query outputs that these cards and the original draw on. A card binds one by its id in its data, as {"rows": "r2"}, and gets its rows:')
    for (const o of outputs) out.push(`<output id="${o.id}" about="${String(o.about || '').replace(/"/g, "'")}">`, String(o.text || '').replace(/\s+$/, ''), '</output>')
  }
  return out.join('\n')
}

/** The card guide's toolkit, which a card's program is written with: its section from "## The toolkit" to the next
 *  heading of that level, or the whole guide when it has none. */
export function toolkitOf(guide) {
  const s = String(guide || '')
  const m = /^## The toolkit[^\n]*$/m.exec(s)
  if (!m) return s.trim()
  const rest = s.slice(m.index + m[0].length)
  const next = /^## /m.exec(rest)
  return (m[0] + (next ? rest.slice(0, next.index) : rest)).trim()
}

/** What a card shows the analyst, as text a rewrite is held to: its data's values (the rows its program draws), with
 *  the keys that only lead to source rows left out. At most `max` characters. */
export function drawnOf(o, max = 20000) {
  try {
    return JSON.stringify(o && o.data != null ? o.data : {}, (k, v) => (k.startsWith('_') ? undefined : v)).slice(0, max)
  } catch {
    return ''
  }
}

/** The answer a rewrite is held to (checkRewrite): the message as written and, when the request showed its cards,
 *  each card's title, takeaway and the values it draws, since the analyst read those too. */
export const answerText = (text, cards = []) => [String(text || ''), ...cards.map(c => `${c.title || ''}\n${c.text || ''}\n${c.drawn || ''}`)].join('\n')

/** The query ids a card's data binds and a text cites (`r2#...`, `r4@n`, `q3`), in order, each once. */
export function queryIdsOf(texts = [], bindings = []) {
  const ids = []
  const add = id => { if (/^[qr]\d+$/.test(id) && !ids.includes(id)) ids.push(id) }
  for (const b of bindings) if (typeof b === 'string') add(b.split(/[#@]/)[0])
  for (const t of texts) for (const m of String(t || '').matchAll(/\]\(([qr]\d+)(?:[#@)])/g)) add(m[1])
  return ids
}

/** The spec a card change saves: an edit lays its parts over the original card's spec (its data bindings merged), an
 *  add is its own. The takeaway is the card's `text`. */
export function cardSpec(change, source = {}) {
  const base = change.op === 'add' ? {} : { ...(source || {}) }
  const spec = { ...base }
  if (change.title != null) spec.title = change.title
  if (change.takeaway != null) spec.text = change.takeaway
  if (change.program != null) spec.program = change.program
  if (change.data != null) spec.data = change.op === 'add' ? change.data : { ...((base.data && typeof base.data === 'object' && !Array.isArray(base.data)) ? base.data : {}), ...change.data }
  return spec
}

const sameRef = (a, b) => a.id === b.id && (a.root ?? null) === (b.root ?? null)

/**
 * The cards of a version, by row, from the original's (`orig`: {row: [ref]}) and the changes that held (`done`:
 * [{op, id, ref, title}], each edit and add with the ref it saved): an edit takes its card's place, an add goes after
 * the last card of the answer (`row`), a drop leaves its card out. Returns {rows, did}.
 */
export function cardsAfter(orig, row, done) {
  const rows = Object.fromEntries(Object.entries(orig || {}).map(([r, l]) => [r, [...(l || [])]]))
  if (!rows[row]) rows[row] = []
  const did = []
  for (const d of done || []) {
    if (d.op === 'add') { rows[row].push(d.ref); did.push({ id: d.ref.id, did: 'added', title: d.title || d.ref.id, v: d.ref.v }); continue }
    for (const [r, l] of Object.entries(rows)) {
      const i = l.findIndex(x => x.id === d.id)
      if (i < 0) continue
      if (d.op === 'edit') { l[i] = { ...l[i], ...d.ref }; did.push({ id: d.id, did: 'edited', title: d.title || d.id, v: d.ref.v }) }
      else { l.splice(i, 1); did.push({ id: d.id, did: 'left out', title: d.title || d.id }) }
      rows[r] = l
      break
    }
  }
  return { rows, did }
}

/** The key of the version a record shows now: its levels' key, or `orig` at the original (a catch-up let go too). */
function versionKey(rec) {
  if (!rec || typeof rec.shown !== 'string') return 'orig'
  if (isCatchUp(rec) && rec.catchup.dismissed) return 'orig'
  return keyOf(chipsOf(rec))
}

/** The cards a record's version shows, by row: that version's when it changed a card, else the original's. Null when
 *  no rewrite of it ever touched its cards (the cards under it are then as they are). */
export function cardListsAt(rec) {
  const s = sq(rec)
  const orig = s.orig && s.orig.cards
  if (!orig || !s.cards || !Object.keys(s.cards).length) return null
  const v = s.cards[versionKey(rec)]
  return { ...orig, ...((v && v.rows) || {}) }
}

/** What the version shown now did to the cards: [{id, did, title}], [] at the original or with no change. */
export function cardsDid(rec) {
  const s = sq(rec)
  const v = s.cards && s.cards[versionKey(rec)]
  return (v && Array.isArray(v.did)) ? v.did : []
}

/** What the version shown now did to the cards under one row, for the notes drawn there: `marks` {id: 'edited' |
 *  'added'} for the cards drawn, and `left` the titles of the row's cards it left out. */
export function cardNotesFor(rec, row) {
  const did = cardsDid(rec)
  const out = { marks: {}, left: [] }
  if (!did.length) return out
  const s = sq(rec)
  const orig = (s.orig && s.orig.cards && s.orig.cards[row]) || []
  const now = (cardListsAt(rec) || {})[row] || []
  for (const d of did) {
    if (d.did === 'left out') { if (orig.some(x => x.id === d.id)) out.left.push(d.title) }
    else if (now.some(x => x.id === d.id)) out.marks[d.id] = d.did
  }
  return out
}

/** Every card any version of the record drew or the original had: the cards the squeeze answers for. */
export function cardsKnown(rec) {
  const s = sq(rec)
  const out = []
  const add = l => { for (const x of l || []) if (x && x.id && !out.some(y => sameRef(x, y))) out.push(x) }
  for (const l of Object.values((s.orig && s.orig.cards) || {})) add(l)
  for (const v of Object.values(s.cards || {})) for (const l of Object.values((v && v.rows) || {})) add(l)
  return out
}

/** A row's cards as a version wants them, with the cards drawn there since that the squeeze never touched (a card v
 *  made later) kept after them. */
export function withLater(current, want, known) {
  const later = (current || []).filter(x => !known.some(y => sameRef(x, y)))
  return [...(want || []), ...later]
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

/** The indent of a line, in columns. */
const indentOf = l => /^[ \t]*/.exec(l)[0].replace(/\t/g, '    ').length

/**
 * The items of a list, each with what stands under it: an item at the list's own indent starts one, and the lines
 * indented more (its sub-items, its wrapped lines) stay with it. Each comes back as markdown: the item's own words on
 * the first line (its marker dropped), then the lines under it, indented as they stand under the item.
 */
export function listItems(lines) {
  const at = lines.findIndex(l => ITEM.test(l))
  if (at < 0) return []
  const base = indentOf(lines[at])
  const out = []
  for (const l of lines.slice(at)) {
    if (!l.trim()) continue
    if (ITEM.test(l) && indentOf(l) <= base) out.push([l.replace(ITEM, '')])
    else if (out.length) out[out.length - 1].push(' '.repeat(Math.max(0, indentOf(l) - base)) + l.trimStart())
  }
  return out.map(x => x.join('\n'))
}

/** A correction as the request and a put-back carry it: whole lines, at most `max` characters, at most 600 a line. */
function clipLines(x, max = 2000) {
  const out = []
  let n = 0
  for (const line of x.split('\n')) {
    const l = line.length > 600 ? `${line.slice(0, 599)}…` : line
    if (out.length && n + l.length + 1 > max) { out.push('…'); break }
    out.push(l)
    n += l.length + 1
  }
  return out.join('\n')
}

/**
 * The corrections of Claude's own earlier answer in a message, as the original writes them (markdown, links kept): a
 * list under a lead that says it corrects ("Two corrections to my last answer:") gives each item with the sub-items
 * under it, so a heading item ("**The numbers I didn't cite before:**") keeps the list it heads; a paragraph that
 * opens with such a lead is one; a sentence that sets an earlier statement right is one. At most `max`, each cut at a
 * line to at most 2,000 characters.
 */
export function mustKeep(text, { max = 4 } = {}) {
  const out = []
  const add = t => {
    const x = String(t || '').trim()
    if (!x || out.some(y => y === x || y.includes(x) || x.includes(y))) return
    out.push(clipLines(x))
  }
  const paras = String(text || '').split(/\n\s*\n/)
  for (const para of paras) {
    const lines = para.split('\n')
    const lead = lines.findIndex(l => !ITEM.test(l) && !OFFER.test(plainLine(l)) && OWN.test(plainLine(l).split(/(?<=[.!?])\s/)[0] || ''))
    if (lead >= 0 && /:\s*$/.test(plainLine(lines[lead]).trim())) {
      // a list under the lead: each item a correction, with its sub-items
      const items = listItems(lines.slice(lead + 1))
      if (items.length) { items.forEach(add); continue }
    }
    if (lead === 0 && !ITEM.test(lines[0])) { add(para); continue }
    for (const sent of para.split(/(?<=[.!?])\s+(?=[A-Z*"(])/)) if (SAID.test(plainLine(sent)) && !OFFER.test(plainLine(sent))) add(sent)
  }
  return out.slice(0, max)
}

/**
 * The corrections a rewrite left out, put back: one whose numbers (or, with none, most of its words) are not in the
 * rewrite is added after it, as the original says it. With the `original`, a number it states outside the correction
 * too (a time, an agent's number) does not count as the correction's. A correction with sub-items is checked item by
 * item, and the items left out come back under its first line, so a heading never comes back without what it heads.
 * A correction may be shortened, never dropped. Returns the text and the corrections put back.
 */
export function keepCorrections(text, keep, original = '') {
  const have = plainLine(text).toLowerCase()
  const nums = new Set(numbersIn(plainLine(text)))
  const kept = k => {
    const n = numbersIn(plainLine(k)).filter(x => x.length > 1)
    const rest = original && String(original).includes(k) ? new Set(numbersIn(plainLine(String(original).split(k).join(' ')))) : null
    const own = rest ? n.filter(x => !rest.has(x)) : []
    const words = plainLine(k).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []
    return n.length ? (own.length ? own : n).some(x => nums.has(x)) : words.filter(w => have.includes(w)).length >= Math.ceil(words.length * 0.5)
  }
  const back = []
  for (const k of keep || []) {
    const [head = '', ...under] = String(k).split('\n')
    const subs = listItems(under)
    if (!subs.length) { if (!kept(k)) back.push(k); continue }
    // a heading item says nothing of its own: what it heads is what must stay
    const left = subs.filter(s => !kept(s))
    if (!left.length && (isHeading(head) || kept(head))) continue
    back.push([head, ...left.map(s => `- ${s.replace(/\n/g, '\n  ')}`)].join('\n'))
  }
  return { text: back.length ? `${String(text).trimEnd()}\n\n${back.join('\n\n')}` : text, back }
}

/** A line that only heads what comes under it: a markdown heading, a bold lead that is no sentence, or a line that
 *  ends in a colon. */
export function isHeading(line) {
  const l = String(line || '').trim().replace(ITEM, '')
  if (!l) return false
  if (/^#{1,6}\s+\S/.test(l)) return true
  if (/:\s*$/.test(plainLine(l))) return true
  const bold = /^(\*\*|__)([^*\n]+?)\1$/.exec(l)
  return !!bold && !/[.!?]["')\]]*$/.test(bold[2].trim())
}

/**
 * A rewrite that ends on a heading with nothing under it (its last line "**The numbers I didn't cite before:**")
 * loses that heading: it promises what the text does not give. Returns the text and the headings dropped.
 */
export function dropOrphanHeads(text) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n')
  const dropped = []
  while (lines.length > 1 && isHeading(lines[lines.length - 1])) {
    dropped.unshift(lines.pop().trim())
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop()
  }
  return { text: dropped.length ? lines.join('\n') : String(text || ''), dropped }
}

const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
const norm = s => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1')
const numbersIn = s => (norm(String(s).replace(LINK, '$1 $2')).match(/\d+(?:\.\d+)?/g) || []).filter(n => n.length > 1 || Number(n) > 9)

/** The forms a stated value may be rounded to in a rewrite: itself, a whole number, one decimal, and a share between
 *  0 and 1 as a percent. */
function roundings(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || !n.includes('.')) return [n]
  const forms = [n, String(Math.round(v)), String(Math.round(v * 10) / 10)]
  if (v > 0 && v < 1) forms.push(String(Math.round(v * 100)), String(Math.round(v * 1000) / 10))
  return forms
}

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
  // a value the original states counts in the forms a rewrite may round it to: a whole number, one decimal, and a
  // share (0.369) as a percent (37, 36.9)
  const have = new Set(numbersIn(original).flatMap(roundings))
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
/** @param {any} rec @param {{text: string, at: Record<string, number>, made?: any, problems?: string[], cards?: {rows: Record<string, any[]>, did: any[]} | null, origCards?: Record<string, any[]> | null}} change @param {(r: any) => any} remark */
export function applyRewrite(rec, { text, at, made = null, problems = [], cards = null, origCards = null }, remark) {
  const s0 = sq(rec)
  const orig = s0.orig || { marks: (rec.shown == null ? rec.marks : []) || [] }
  // the original's cards, kept from the first rewrite that was shown them
  const s = { ...s0, at: { ...at }, scale: SCALE, versions: scaledVersions(s0), orig: origCards && !orig.cards ? { ...orig, cards: origCards } : orig }
  const probe = { ...rec, squeeze: s }
  const chips = chipsOf(probe)
  const key = keyOf(chips)
  s.versions[key] = text
  // the cards of this version, when it changed one; a version that changed none shows the original's
  const kept = { ...(s0.cards || {}) }
  if (cards && Array.isArray(cards.did) && cards.did.length) kept[key] = cards
  else delete kept[key]
  if (Object.keys(kept).length) s.cards = kept
  else delete s.cards
  s.problems = problems
  if (made) s.made = [...(s0.made || []), { key, ...made }].slice(-20)
  const prev = [...(rec.marks || []), ...((s.orig && s.orig.marks) || [])]
  const next = isOriginal(chips) ? { ...rec, shown: null, squeeze: s } : { ...rec, shown: text, squeeze: s }
  return remark({ ...next, marks: prev })
}

/** The versions kept, keyed by the chips' scales now: a record from before them keeps those Length's short and one
 *  line wrote, and drops the ones no level names now (Length's medium, Background's old five levels). */
function scaledVersions(s) {
  const v = { ...(s.versions || {}) }
  const scale = Number(s.scale) || 1
  if (scale >= SCALE) return v
  for (const k of Object.keys(v)) if ((scale < 2 && /(^|&)length=[23](&|$)/.test(k)) || /(^|&)familiarity=/.test(k)) delete v[k]
  return v
}

/** The record at a set of levels already written (a level seen before): no call. Null when that version is not kept. */
export function fromVersions(rec, at, remark) {
  const s = sq(rec)
  const chips = chipsOf({ ...rec, squeeze: { ...s, at, scale: SCALE } })
  if (isOriginal(chips)) return restore({ ...rec, squeeze: { ...s, at } }, remark)
  const text = scaledVersions(s)[keyOf(chips)]
  if (typeof text !== 'string') return null
  const prev = [...(rec.marks || []), ...((s.orig && s.orig.marks) || [])]
  return remark({ ...rec, shown: text, squeeze: { ...s, at, scale: SCALE, versions: scaledVersions(s), problems: [] }, marks: prev })
}

/** The original again: every chip back where the original stands, the person's chips kept (off). */
export function restore(rec, remark) {
  const s = sq(rec)
  const prev = [...((s.orig && s.orig.marks) || []), ...(rec.marks || [])]
  return remark({ ...rec, shown: null, squeeze: { ...s, at: {}, scale: SCALE, versions: scaledVersions(s), problems: [] }, marks: prev })
}


/** A message's first words, plain (a citation as its words), for naming it to Claude. */
export function firstWordsOf(text, n = 8) {
  const words = String(text || '').replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/^[#>|\s]+/gm, ' ').split(/\s+/).filter(Boolean)
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '')
}

/** A record's time as the person saw it, `14:05`; '' when it has none. */
export function clockOf(at) {
  const d = at ? new Date(at) : null
  return d && !Number.isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
}

/** The version of a record Claude was last told of, as one key: `orig` while it shows as written. */
export function shownKey(rec) {
  if (!rec) return 'orig'
  if (isCatchUp(rec)) return rec.catchup.dismissed || typeof rec.shown !== 'string' ? 'orig' : `cu:${keyOf(chipsOf(rec))}:${rec.shown.length}`
  return typeof rec.shown === 'string' ? `v:${keyOf(chipsOf(rec))}:${rec.shown.length}` : 'orig'
}

/**
 * What Claude reads, as a row of its own that the person never sees, once the person settled on a version of its
 * message (the chips closed, or they sent their next prompt): the version they read, whole, so a later turn knows what
 * they saw. A catch-up names the replies it stands in for. `told` says the version Claude was told of before: going
 * back to the original is said only after a version was told. Empty when there is nothing new to say.
 */
export function settledNote(rec, told = 'orig') {
  if (!rec || shownKey(rec) === told) return ''
  const set = chipsOf(rec).filter(c => c.level !== c.level0).map(c => `${c.name}: ${c.levels[c.level]}`).join(', ')
  // the cards under it, when this version changed them, and back as they were when an earlier one had
  const did = cardsDid(rec)
  const cards = did.length ? `\n\nIts cards changed with it: ${did.map(d => `"${d.title}" (${d.id}) ${d.did}${d.did === 'edited' ? `, now version ${d.v}` : ''}`).join('; ')}.` : ''
  const asWere = sq(rec).cards ? ', with its cards as they were' : ''
  if (isCatchUp(rec)) {
    const n = Number(rec.catchup.replies) || 0
    const of = n === 1 ? 'reply' : `${n} replies`
    if (rec.catchup.dismissed || typeof rec.shown !== 'string') return told === 'orig' ? '' : `The analyst went back to reading your ${of} since their last prompt as you wrote them${asWere}.`
    const named = String(rec.text || '').split('\n\n---\n\n').map(t => `"${firstWordsOf(t)}"`).join('; ')
    return `The analyst caught up on your ${of} since their last prompt. In place of those messages (${named}), they now read one message that the squeeze chips wrote of them${set ? ` (${set})` : ''}:\n\n${rec.shown.slice(0, 12000)}${cards}\n\n(What you wrote is unchanged, and the analyst can go back to it.)`
  }
  const when = clockOf(rec.at)
  const which = `Your message${when ? ` from ${when}` : ''} ("${firstWordsOf(rec.text)}")`
  if (typeof rec.shown !== 'string') return told === 'orig' ? '' : `${which} reads again, for the analyst, as you wrote it${asWere}.`
  return `${which} now reads, for the analyst, as:\n\n${rec.shown.slice(0, 12000)}${cards}\n\n(The squeeze chips wrote this version of yours${set ? ` (${set})` : ''}. What you wrote is unchanged, and the analyst can go back to it.)`
}
