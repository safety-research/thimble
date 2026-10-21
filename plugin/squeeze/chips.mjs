// chips.mjs: Squeeze as chips under a message. No `$`, no Node, no DOM: the hooks module (term.ts), the chips pane
// (panes/chips.js) and the tests import it.
//
// The chips are the same for every message; only where the original stands on each differs:
//   Length              short · as written · longer · much longer. The original is always "as written": a shorter
//                       version leaves parts out, a longer one explains more and adds detail.
//   Interpretation      facts only · as written · expert reading: how much the text says beyond what the facts
//                       literally say, from the facts alone to an expert's reading of them, with the background a
//                       reader needs to follow it. The original is always "as written".
//   a chip the person typed, after +: their own words ("for my manager", "more skeptical", "as a timeline",
//                       "engineer → manager"), as written · a little · more · fully. The original stands at as written.
// Each level is defined once, here (MEANS), and the request carries only the definition of the level picked (pickLine).
// A message arrives as Claude wrote it; the chips rewrite it on demand. Every chip counts in every rewrite: one
// $.model.complete call writes the message at all the chips' levels at once, and each version written is kept, so a
// state seen before comes back with no call.
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
//     scale:    4                     the chips' scales now: Length short · as written · longer · much longer, no
//                                     Background chip (records before scale 4 had one line first and a Background
//                                     chip; before scale 2, one line · short · medium · full): levelsAt reads them
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
import { linkSpans, mapLinks } from '../shell/message.js'

/** The chips every message has, in the order drawn. `level0` is where the original stands: "as written". */
export const CHIPS = Object.freeze([
  Object.freeze({ id: 'length', name: 'Length', levels: Object.freeze(['short', 'as written', 'longer', 'much longer']), level0: 1, kind: 'fixed' }),
  // (the id is the records' since before the chip was renamed)
  Object.freeze({ id: 'interpret', name: 'Interpretation', levels: Object.freeze(['facts only', 'as written', 'expert reading']), level0: 1, kind: 'fixed' }),
])
export const LENGTH = CHIPS[0]
/** The level of Length a catch-up arrives at: short. */
export const ARRIVE = 0
/** The chips' scales now (the record's `scale`): Length without one line, and no Background chip. */
export const SCALE = 4

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

/** A chip's level in words: its name, and `as written` where the original stands. */
export function levelWords(c) {
  return c.level === c.level0 ? 'as written' : c.levels[c.level] || ''
}

/** The levels set away from the original, in words (`short · interpret`), or '' at the original. */
export function setWords(rec) {
  return chipsOf(rec).filter(c => c.level !== c.level0).map(c => c.levels[c.level]).join(' · ')
}

/** `at` as the chips' scales read it now. Length's one line is gone (scale 4): a record from before reads one line
 *  and short as short, and its longer levels one lower. A record written before Length had its original in the middle
 *  (scale 2) had one line · short · medium · full with the original at full, so full is the original and the rest reads
 *  as short. The Background chip is gone, and its level with it. */
function levelsAt(s) {
  let at = s.at && typeof s.at === 'object' ? s.at : {}
  // (a record of before has versions written; a new one has none until its first rewrite, which sets the scale)
  const scale = Number(s.scale) || 1
  if (scale >= SCALE || !Object.keys(s.versions || {}).length) return at
  const { length, familiarity: _gone, ...rest } = at
  if (!Number.isInteger(length)) return rest
  const was = scale < 2 ? (length >= 3 ? null : 0) : length === 2 ? null : Math.max(0, length - 1)
  return was == null ? rest : { ...rest, length: was }
}

/** The levels set now, as the chips' scales read them (a record from before is read as levelsAt says). */
export const atOf = rec => levelsAt(sq(rec))

/** A chip the person typed, as a chip: its words are its name, and its levels run from the original to fully. */
function ownChip(c) {
  return { id: c.id, kind: 'own', name: c.words, words: c.words, levels: [...OWN_LEVELS], level0: 0 }
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

/** Every chip of the message, in the order drawn: the fixed ones, then the ones the person typed. Each with `level0`,
 *  where the original stands, and `level`, where it is now. (A record from before may hold where an observer placed
 *  the original on Interpretation, record.verbs.s.at: it is not read, and the original stands at "as written".) */
export function chipsOf(rec) {
  const s = sq(rec)
  const at = levelsAt(s)
  const fixed = CHIPS.map(c => ({ ...c, levels: [...c.levels] }))
  const own = (Array.isArray(s.own) ? s.own : []).filter(c => c && c.id && c.words).map(ownChip)
  return [...fixed, ...own].map(c => {
    const want = at[c.id]
    const level = Number.isInteger(want) && want >= 0 && want < Math.max(1, c.levels.length) ? want : c.level0
    return { ...c, level }
  })
}

/** The levels that differ from the original, as one key: the same key, the same version. A chip at the original's
 *  level is "as the original" and is not in the key. */
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

// ------------------------------------------------------------------------------------------------ how long it is

/** The rows a text takes at `cols` columns, as drawn: each line wrapped at spaces, a link as its words, a blank line one
 *  row. Close to what the terminal draws, which is what "6 of 33 lines" counts. */
export function rowsOf(text, cols = 100) {
  const w = Math.max(20, cols)
  let n = 0
  for (const raw of mapLinks(text || '', (all, words) => words).replace(/\*\*|`/g, '').split('\n')) {
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
  return mapLinks(text || '', (all, words) => words).split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
}

const round = n => (n >= 40 ? Math.round(n / 5) * 5 : Math.max(1, Math.round(n)))

/**
 * What each level asks of the text: the one definition the request carries for a chip at that level (pickLine). Each
 * is a function of the message: `words`, the original's length in words, which Length turns into the number the model
 * aims for (it keeps a number better than a level's name); `data`, whether the request shows cards or query outputs
 * to add detail from; `keep`, how many corrections the request lists. A typed chip's words stand in its line, so its
 * definitions say "these words".
 */
export const MEANS = Object.freeze({
  length: Object.freeze([
    m => `About a quarter of the original, about ${round(m.words / 4)} words${m.keep ? ', not counting the corrections listed above' : ''}. Keep the main point and the facts it rests on, and leave out the rest.`,
    m => `About as long as the original, about ${m.words} words.`,
    m => `About one and a half times the original, about ${round(m.words * 1.5)} words. Explain what the original says more fully, such as what a term means or how one step led to the next.${m.data ? ' Add detail from the cards and the query outputs where it helps, each new number cited to its place in them.' : ''}`,
    m => `About two and a half times the original, about ${round(m.words * 2.5)} words. Give each point in full, with each term explained and each step that led to it.${m.data ? ' Add the detail behind each point from the cards and the query outputs, each new number cited to its place in them.' : ''}`,
  ]),
  // (as written, the middle, asks nothing: the chip is not named in the request while it stands there)
  interpret: Object.freeze([
    () => 'State what was found: counts, values, what happened, and sentences that sum them up or rank them. Leave out why it happened, what follows from it and what to do.',
    () => '',
    () => "Lead with Claude's reading of the facts, as an expert in the field reads them: the likely cause, what is usual and what is not, what follows, and what to do. Add the background a reader needs to follow that reading. Say where the reading starts, as in \"My read:\", so the analyst can tell it from what was found.",
  ]),
  own: Object.freeze([
    () => '',
    () => 'Move the text a little toward what these words ask, and keep most of it as it is.',
    () => 'Move the text clearly toward what these words ask.',
    () => 'Write the whole text as these words ask.',
  ]),
})

/** One chip as the request names it, the analyst's pick and what it asks: Length always, since it gives the length to
 *  aim for, and any other chip only when it stands away from the original. '' for a chip left where the original is. */
export function pickLine(c, m = {}) {
  const ctx = { words: 0, data: false, keep: 0, ...m }
  if (c.id !== LENGTH.id && c.level === c.level0) return ''
  const means = (c.kind === 'own' ? MEANS.own : MEANS[c.id])?.[c.level]
  const what = means ? means(ctx) : ''
  const name = c.kind === 'own' ? `The analyst's words, "${c.words}"` : c.name
  return `- ${name}: ${c.levels[c.level]}.${what ? ` ${what}` : ''}`
}

/** The line that heads the original in a catch-up's request: several messages, written as one. */
export const CATCHUP_HEAD = "The original answer: Claude's messages since the analyst's last prompt, in the order it wrote them. Write them as one message."

/** A catch-up's original: Claude's messages, in order, one after another. */
export const catchUpText = texts => (texts || []).map(t => String(t || '').trim()).filter(Boolean).join('\n\n---\n\n')

/** Whether a record is a catch-up, and one that still stands (not dismissed). */
export const isCatchUp = rec => !!(rec && rec.catchup && typeof rec.catchup === 'object')
export const catchUpStands = rec => isCatchUp(rec) && !rec.catchup.dismissed

/**
 * The $.model.complete request that writes the message at its chips' levels: the input (the question, the original,
 * its cards and the outputs they draw on, the corrections and terms it holds), then what the analyst picked, each
 * chip with only its level's definition. `system` is squeeze.md's text, and `toolkit` the card guide's toolkit, sent
 * only with cards. The fixed text goes first and is marked for the prompt cache: squeeze.md, then the input, so a
 * second change of the same message reads them from the cache.
 */
/** @param {any} rec @param {{system?: string, toolkit?: string, question?: string, chips?: any[], keep?: string[], terms?: string[], cards?: any[], outputs?: any[], model?: string, effort?: string, maxTokens?: number, timeoutMs?: number}} [opts] */
export function request(rec, { system, toolkit = '', question = '', chips = chipsOf(rec), keep = [], terms = [], cards = [], outputs = [], model = 'sonnet', effort = 'low', maxTokens = 4000, timeoutMs = 90000 } = {}) {
  const drawn = cardsBlock(cards, outputs)
  // the corrections in the original stay at every level, shortened if need be (mustKeep); the length does not count them
  const kept = keep.length ? ['', 'Corrections in the original. Each stays in your version, in as few words as it needs, next to what it corrects:', ...keep.map(k => `- ${k}`)] : []
  // the terms the person can open an explanation of (explain marks): kept in their own words where the text keeps them
  const named = terms.length ? ['', 'Terms the analyst can open an explainer of. Where your text keeps what a term names, use the term in these words:', ...terms.map(t => `- ${t}`)] : []
  const head = [
    question ? `The analyst asked: ${question.trim().slice(0, 2000)}` : 'The analyst\'s question is not known.',
    '',
    isCatchUp(rec) ? CATCHUP_HEAD : 'The original answer, as Claude wrote it:',
    '<original>',
    String(rec?.text ?? ''),
    '</original>',
    ...(drawn ? ['', drawn] : []),
    ...kept,
    ...named,
  ].join('\n')
  const m = { words: wordsOf(rec?.text), data: !!drawn, keep: keep.length }
  const lines = chips.map(c => pickLine(c, m)).filter(Boolean)
  const tail = ['The analyst picked:', ...lines, '', `Write back the answer at these levels: the message in <text>${drawn ? ', then a block for each card it changes' : ''}.`]
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
const plainLine = t => mapLinks(t, (all, words) => words).replace(/[*_`]/g, '')

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

const norm = s => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1')
const numbersIn = s => (norm(mapLinks(s, (all, words, ref) => `${words} ${ref}`)).match(/\d+(?:\.\d+)?/g) || []).filter(n => n.length > 1 || Number(n) > 9)

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
 * A rewrite held to the original: a number the original never states is named as a problem. Its citations stay as
 * written: the healing pass checks each one against its place, as it checks every citation of a shown text
 * (shell.tsx runHeal), and re-points it, marks it × when the place contradicts it, or unwraps it when the place is
 * gone. Returns the text to show and the problems.
 */
export function checkRewrite(original, text) {
  const problems = []
  const out = String(text)
  // a value the original states counts in the forms a rewrite may round it to: a whole number, one decimal, and a
  // share (0.369) as a percent (37, 36.9)
  const have = new Set(numbersIn(original).flatMap(roundings))
  const stray = [...new Set(numbersIn(mapLinks(out, (all, words) => words)).filter(n => !have.has(n)))]
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
  // a link, inline code or bold left open on this line: on to where it closes (a link's target may hold brackets)
  const links = linkSpans(s)
  for (let guard = 0; guard < 8 && i < s.length; guard++) {
    const line = s.slice(s.lastIndexOf('\n', i - 1) + 1, i)
    const ticks = (line.match(/`/g) || []).length
    const stars = (line.match(/\*\*/g) || []).length
    const openLink = /\[[^\]\n]*$|\]\([^)\n]*$/.test(line)
    const link = links.find(m => m.index < i && i < m.index + m[0].length)
    if (ticks % 2) { const e = s.indexOf('`', i); i = e < 0 ? s.length : e + 1; continue }
    if (stars % 2) { const e = s.indexOf('**', i); i = e < 0 ? s.length : e + 2; continue }
    if (link) { i = link.index + link[0].length; continue }
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

/** The versions kept, keyed by the chips' scales now: a record from before them drops the ones Length or the
 *  Background chip wrote, whose keys no level names now, and keeps the ones of Interpretation alone. */
function scaledVersions(s) {
  const v = { ...(s.versions || {}) }
  const scale = Number(s.scale) || 1
  if (scale >= SCALE) return v
  for (const k of Object.keys(v)) if (/(^|&)(length|familiarity)=/.test(k)) delete v[k]
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
  const words = mapLinks(text || '', (all, words) => words).replace(/\*\*|__|`/g, '').replace(/^[#>|\s]+/gm, ' ').split(/\s+/).filter(Boolean)
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
