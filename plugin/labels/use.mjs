// use.mjs: the pure parts of the label rows and of the ask before a large label run (labels/use.ts draws them). No `$`.
//
//   howMade(kind)                 -> how a label was made, in a few plain words: 'regex', 'code', 'read by Claude',
//                                    'values Claude gave' (the row and the labels pane both say it so)
//   rowValues(l)                  -> the values a row names: those some record has, then the records with no value
//   tonesInTree(tree, values)     -> {value: color}: where a card's drawing (the runner's tree of Box, Text and Button
//                                    nodes) first names a label's value as a word of its own in a color (a legend, a
//                                    bar's name), or in plain words after a mark in a color (`■ agent`), never on a fill
//   usedNames(uses, shown)        -> the names of the labels a turn used (each once, in order) that `shown` leaves out
//   askOf(ev)                     -> the ask a `label_ask` line of the change feed carries, or null
//   sampleOffered(ask)            -> whether the ask offers a sample: not after the person chose one (an ask for the
//                                    rest), nor when all fit in one
//   askChoices(ask)               -> [{key, words, choice, time}]: 1 run all (or run the rest), 2 run on a sample of N,
//                                    0 cancel; `time`, about how long the reads take ('' for cancel)
//   askTime(calls)                -> about how long `calls` model calls take, in words ('about 2 min')
//   askQuestion(ask)              -> the ask as the question the person answers
//   choiceEcho(ask, choice)       -> what the band says for a moment after the person chose
//   ASK_KEYS                      -> {'1': 'all', '2': 'sample', '0': 'cancel'}
//   answerNote(ask, choice, got)  -> what Claude hears with the next prompt after the person's choice

import { SETTINGS } from './labelreads.mjs'

/** A label's name, as the kernel takes it (engine/kernel/labels.py). */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/

export const ASK_KEYS = { 1: 'all', 2: 'sample', 0: 'cancel' }

export function howMade(kind) {
  if (kind === 'prompt') return 'read by Claude'
  if (kind === 'set') return 'values Claude gave'
  if (kind === 'regex') return 'regex'
  if (kind === 'code') return 'code'
  return ''
}

/** The records with no value yet, as the labels pane names them (ledger.mjs partsOf). */
export const NO_VALUE = '-'

/** The values a row names, as {v, name}, from a label as `thimble label --json` gives it: each value some record has,
 *  in the label's order, then the records that wait for the model or got no value (`v` '-'). A label read with no
 *  counts names its values. So a label whose records all got no value says that, and names no value it never gave. */
export function rowValues(l) {
  const values = Array.isArray(l?.values) ? l.values.map(String) : []
  const counts = l && typeof l.counts === 'object' && l.counts ? l.counts : null
  if (!counts) return values.map(v => ({ v, name: v }))
  const given = [...values, ...Object.keys(counts).filter(v => !values.includes(v))]
  const out = given.filter(v => Number(counts[v]) > 0).map(v => ({ v, name: v }))
  const none = (Number(l.waiting) || 0) + (Number(l.failed) || 0)
  if (none) out.push({ v: NO_VALUE, name: l.waiting ? 'not labeled yet' : 'no value' })
  return out
}

// the marks a legend puts before a value's name in the value's color (`■ agent`)
const SWATCH = /^[■●▪◼█▆▇▌◆▲]$/u
// colors that carry no color of their own
const PLAIN = /^(text|inactive|subtle|secondaryText|dim|gray|grey)$/i

/** The tree's words, in reading order, each character with the color its Text gives it (inherited from the Text
 *  around it), and whether it lies on a fill or is dim. A Box ends a run of words (a new line or a new cell). */
function runsOf(tree) {
  const chars = []
  const walk = (n, look) => {
    if (n == null || n === false) return
    if (typeof n === 'string' || typeof n === 'number') {
      for (const ch of String(n)) chars.push({ ch, ...look })
      return
    }
    if (Array.isArray(n)) { n.forEach(x => walk(x, look)); return }
    if (typeof n !== 'object') return
    const p = n.p || {}
    const next = n.t === 'Text'
      ? { color: typeof p.color === 'string' ? p.color : look.color, bg: !!p.backgroundColor || !!p.inverse || look.bg, dim: !!p.dimColor || look.dim }
      : look
    if (n.t === 'Box') chars.push({ ch: '\n' })
    walk(n.c, next)
    if (n.t === 'Box') chars.push({ ch: '\n' })
  }
  walk(tree, { color: undefined, bg: false, dim: false })
  return chars
}

const colored = c => !!c && !!c.color && !PLAIN.test(c.color) && !c.bg && !c.dim

export function tonesInTree(tree, values) {
  const out = {}
  const chars = runsOf(tree)
  const text = chars.map(c => c.ch).join('')
  for (const v of values || []) {
    if (typeof v !== 'string' || !v.trim()) continue
    let i = text.indexOf(v)
    while (i >= 0) {
      const before = text[i - 1]
      const after = text[i + v.length]
      const word = !(before && /[\p{L}\p{N}_]/u.test(before)) && !(after && /[\p{L}\p{N}_]/u.test(after))
      const c = chars[i]
      // the mark before it: one or two characters back, over a space
      const back = [1, 2].find(b => i - b >= 0 && !!String(text[i - b]).trim() && text[i - b] !== '\n')
      const mark = back ? chars[i - back] : null
      const marked = mark && SWATCH.test(mark.ch) && !!mark.color && !mark.bg
      const tone = !word || !c || c.bg ? null : colored(c) ? c.color : marked ? mark.color : null
      if (tone) { out[v] = tone; break }
      i = text.indexOf(v, i + 1)
    }
  }
  return out
}

/** The names of the labels a turn used ([{name}], in order, each once) that `shown` (names) leaves out. */
export function usedNames(uses, shown = []) {
  const skip = new Set(shown)
  const out = []
  for (const u of uses || []) {
    const name = u && typeof u.name === 'string' ? u.name : ''
    if (name && !skip.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

export function askOf(ev) {
  if (!ev || typeof ev.name !== 'string' || !ID.test(ev.name) || typeof ev.root !== 'string' || typeof ev.ask !== 'string') return null
  return {
    root: String(ev.root).replace(/\/+$/, ''), name: ev.name, ask: ev.ask,
    text: String(ev.text || `Read ${Number(ev.units) || 0} records with Claude`), meta: String(ev.meta || ''),
    units: Number(ev.units) || 0, sample: Number(ev.sample) || 0, rest: ev.rest === true, calls: Number(ev.calls) || 0,
  }
}

export const sampleOffered = a => !!a && !a.rest && a.sample > 0 && a.units > a.sample

/** About how long one model call of a label run takes (a batch of records, read at low effort), and how many run at
 *  once (labelreads.mjs SETTINGS.parallel): the time an ask names is the calls' rounds times this. Rough, as the
 *  records' length and the API's load change it, so the ask says "about". */
export const CALL_SECONDS = 10
export const PARALLEL = SETTINGS.parallel

export function askTime(calls, parallel = PARALLEL) {
  const n = Math.max(0, Number(calls) || 0)
  if (!n) return ''
  const secs = Math.ceil(n / Math.max(1, parallel)) * CALL_SECONDS
  if (secs < 60) return `about ${Math.max(10, Math.round(secs / 10) * 10)} s`
  return `about ${Math.round(secs / 60)} min`
}

/** The model calls a run of `units` records makes, from the ask's calls for all of them. */
const callsFor = (a, units) => (a.units > 0 && a.calls > 0 ? Math.max(1, Math.ceil((a.calls * units) / a.units)) : 0)

/** An ask's first choice in words: "run all", or "run the rest" after a sample. */
const allWords = a => (a.rest ? 'run the rest' : 'run all')

export function askChoices(a) {
  return [
    { key: '1', words: allWords(a), choice: 'all', time: askTime(callsFor(a, a.units)) },
    ...(sampleOffered(a) ? [{ key: '2', words: `run on a sample of ${a.sample.toLocaleString('en-US')}`, choice: 'sample', time: askTime(callsFor(a, a.sample)) }] : []),
    { key: '0', words: 'cancel', choice: 'cancel', time: '' },
  ]
}

/** The ask as a question: what the run reads, for which label (the kernel's sentence, `Read 2,933 records of
 *  orders.jsonl with Claude`), and that Claude waits for the answer. */
export function askQuestion(a) {
  const text = String(a.text || '').trim()
  return `${text}${a.name ? ` for the label ${a.name}` : ''}?`
}

/** The echo of a choice, in the band for a moment: what runs now. */
export function choiceEcho(a, choice) {
  if (choice === 'cancel') return `canceled: the label ${a.name} reads none of its ${n(a.units)} records`
  if (choice === 'sample') return `labeling a sample of ${n(a.sample)} records for ${a.name}…`
  return `labeling ${a.rest ? 'the other' : 'all'} ${n(a.units)} records for ${a.name}…`
}

const n = x => Number(x || 0).toLocaleString('en-US')

export function answerNote(a, choice, got) {
  if (choice === 'cancel') return `The analyst chose not to run the label ${a.name}: the model reads none of its ${n(a.units)} records.`
  // the reads run now: Claude waits for their counts, and counts it had before the choice (a trial) are not the label's
  const wait = `\`thimble label ${a.name} --wait\` waits for them and prints the label's counts; counts from before this choice (a trial) are not the label's.`
  if (choice === 'all') return `The analyst chose to run the label ${a.name} on ${a.rest ? 'the other' : 'all'} ${n(a.units)} records. The model is reading them beside the session now; ${wait}`
  // a sample: the ask has left the screen, so Claude must not point at a key; the rest needs a new ask
  const reads = Number((got && got.reads) || a.sample)
  const other = Math.max(0, (Number(got && got.of) || a.units) - reads)
  return `The analyst chose a random sample of ${n(reads)} of the label ${a.name}'s ${n(a.units)} records, not all of them. The model is reading the sample beside the session now; ${wait} The choices have left the screen, and the other ${n(other)} records stay without a value. To label them, run the same \`thimble label\` command again without --limit: the terminal then asks the analyst again, to run them or cancel.`
}
