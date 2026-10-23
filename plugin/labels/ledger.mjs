// ledger.mjs: the Labels pane laid out as a ledger, as pure functions over the labels (`thimble label --json`) and one
// page of a value's records (`--records`). No `$`, no elements: pane.tsx draws the rows this returns with Claude Code's
// own elements, and the tests read them as text.
//
//   at rest        each label a short table: its name and what it went over, then a row per value with its bar, its
//                  count and its share of the records. Labels whose tables do not fit fold to one line each: the name,
//                  a small bar of all values, then each value and its count (wrapped)
//   a value open   that label's table in its place, the ▸ on the value; every other label one line (cut with …);
//                  under them the value's examples, one line each: who wrote it, its words around the part the label
//                  matched (that part bold in the value's color), and on the right the person's check or the model's
//                  confidence. `↑ N earlier` and `↓ N more` page the list
//   an example     the picked one opens in place: its words over up to five lines, then where it is (`path:line`) and
//   picked         the check keys (1–9 a value, 0 takes a check back), and why its words are not marked, the model's
//                  reason or the error when there is one
//   definition     d: the label's definition whole in place of the examples, then what it went over
//
// A row is a list of runs, or {code} for a code label's definition. A run is {s, tone, bold, italic, part, hotkey}:
// `tone` dim · accent · err · none (no value yet) · neg (the no of a yes/no label) · track (its bar) · v<i> (the
// label's i-th value), which pane.tsx turns into colors for the theme; `part` what a press on it does (lP label,
// vP value, rP record, cP check, pg-up, pg-down; P a JSON list); `hotkey` the key that presses it, which Claude Code
// draws before it (`1: yes`), so a run with one takes width(hotkey) + 2 more cells.
import { cut, cutWords, textWidth } from '../core/text.js'

export const NONE = '-'
const width = textWidth
const num = x => Number(x || 0).toLocaleString('en-US')
/** A table's bar, and the bar of the records with no value yet. */
const BAR = '▅'
const FAINT = '░'
/** The cells of a folded label's bar, and the most a name takes before its bar. */
const LINE_BAR = 10
const NAME_MAX = 20
/** The lines a picked example's words take at most. */
const TEXT_LINES = 5

const pad = (s, k) => s + ' '.repeat(Math.max(0, k - width(s)))
const lpad = (s, k) => ' '.repeat(Math.max(0, k - width(s))) + s
/** Text on one line, each run of white space one space; `trim` false keeps a space at either end. */
export const oneLine = (s, trim = true) => { const t = String(s ?? '').replace(/\s+/g, ' '); return trim ? t.trim() : t }

export const labelPart = name => `l${JSON.stringify([name])}`
export const valuePart = (name, v) => `v${JSON.stringify([name, v])}`
export const recordPart = ref => `r${JSON.stringify([ref])}`
export const checkPart = v => `c${JSON.stringify([v])}`
/** What a part names: [kind, ...args], or [part] for one with no arguments (pg-up). */
export function partOf(part) {
  const s = String(part || '')
  if (!/^[lvrc]\[/.test(s)) return [s]
  try { return [s[0], ...JSON.parse(s.slice(1))] } catch { return [s] }
}

// ------------------------------------------------------------------------------------------------ a label's values

/** A label's parts: each value with its records, then those that wait for the model or got no value. */
export function partsOf(l) {
  const counts = l?.counts || {}
  const given = Array.isArray(l?.values) ? l.values.map(String) : []
  const values = [...given, ...Object.keys(counts).filter(v => !given.includes(v))]
  const out = values.map(v => ({ v, name: v, n: Number(counts[v]) || 0 }))
  const none = (Number(l?.waiting) || 0) + (Number(l?.failed) || 0)
  if (none) out.push({ v: NONE, name: l.waiting ? 'not labeled yet' : 'no value', n: none })
  return out
}

/** The values a person can open: each value, and the records with none when there are such. */
const openable = l => partsOf(l).filter(p => p.v !== NONE || p.n)

/** The `no` of a yes/no label (or false of true/false): drawn gray, as what the label did not find. */
export function isNegative(values, v) {
  if (!Array.isArray(values) || values.length !== 2) return false
  const [a, b] = values.map(x => String(x).toLowerCase())
  const pair = (y, n) => (a === y && b === n) || (a === n && b === y)
  return (pair('yes', 'no') || pair('true', 'false')) && /^(no|false)$/i.test(String(v))
}

/** A value's tone: none for the records with no value yet, neg for a negative, else v<its index>. */
export function toneOf(values, v) {
  if (v === NONE) return 'none'
  if (isNegative(values, v)) return 'neg'
  return `v${Math.max(0, (values || []).indexOf(v))}`
}
const valuesOf = l => partsOf(l).filter(p => p.v !== NONE).map(p => p.v)
const tone = (l, v) => toneOf(valuesOf(l), v)
const barTone = (l, v) => (tone(l, v) === 'neg' ? 'track' : tone(l, v))

/** `cells` shared by `weights` (largest remainders), each part that is not zero at least one cell while there are
 *  enough. */
export function share(weights, cells) {
  const total = weights.reduce((s, x) => s + x, 0)
  if (!total || cells <= 0) return weights.map(() => 0)
  const exact = weights.map(x => (x * cells) / total)
  const out = exact.map(Math.floor)
  const order = exact.map((c, i) => ({ i, r: c - Math.floor(c) })).sort((a, b) => b.r - a.r)
  for (let k = 0, left = cells - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k % order.length].i]++
  weights.forEach((x, i) => {
    if (x > 0 && !out[i]) {
      const big = out.reduce((b, c, j) => (c > out[b] ? j : b), 0)
      if (out[big] > 1) { out[big]--; out[i] = 1 }
    }
  })
  return out
}

/** A part's share in whole percents, never 0% or 100% for a part that is neither none nor all. */
export function share100(part, all) {
  if (!all) return ''
  const p = (100 * part) / all
  if (part === 0 || part === all) return `${Math.round(p)}%`
  return p < 1 ? '<1%' : p > 99 ? '>99%' : `${Math.round(p)}%`
}

/** What a label went over, short: its records, or `120 of 9,921 at random` for a trial; with the person's checks. */
function scopeShort(l) {
  const n = l.trial ? `${num(l.records)} of ${num(l.matched)} at random` : num(l.records)
  return l.checked ? `you checked ${num(l.checked)} · ${n}` : n
}

/** What a label went over, whole, for its definition. `show` gives a path as the pane shows it. */
export function scopeWords(l, show = p => p) {
  const parts = [`${num(l.records)} record${l.records === 1 ? '' : 's'} in ${l.in ? show(String(l.in)) : 'the records Claude named'}`]
  if (l.where) parts.push(`where ${cut(oneLine(String(l.where)), 160)}`)
  if (l.within) parts.push(`within ${l.within[0]} = ${l.within[1]}`)
  if (l.trial) parts.push(`a trial: ${num(l.records)} of ${num(l.matched)} at random`)
  if (l.checked) parts.push(`you checked ${num(l.checked)}: ${num(l.agree)} agree, ${num(l.disagree)} changed`)
  return parts.join(' · ')
}

const KIND = { code: 'code', regex: 'regex', prompt: 'prompt', set: 'values Claude gave' }

// ------------------------------------------------------------------------------------------------ rows

const runsWidth = runs => runs.reduce((s, r) => s + width(r.s) + (r.hotkey ? width(r.hotkey) + 2 : 0), 0)
const withPart = (runs, part) => runs.map(r => ({ ...r, part }))

/** A row with `right` at its right edge: `left`, then spaces, then `right` (the left cut when both do not fit). */
function spread(left, right, w) {
  const rw = runsWidth(right)
  const lw = runsWidth(left)
  if (lw + 1 + rw <= w) return [...left, { s: ' '.repeat(w - lw - rw) }, ...right]
  return [...left, { s: ' ' }, ...right]
}

/** A label's table: its name and scope, then a row per value: the ▸ on `value`, its name, its bar (its share of the
 *  records), its count and share. */
function block(l, value, w) {
  const name = String(l.name)
  const rows = [spread([{ s: cut(name, Math.max(8, w - 12)), bold: true, part: labelPart(name) }], [{ s: scopeShort(l), tone: 'dim' }], w)]
  const parts = openable(l)
  const all = Number(l.records) || parts.reduce((s, p) => s + p.n, 0)
  const nw = Math.min(Math.max(8, Math.floor(w / 3)), Math.max(8, ...parts.map(p => width(p.name))))
  const bx = 2 + nw + 2
  const bw = Math.max(4, w - bx - 13)
  for (const p of parts) {
    const on = p.v === value
    const cells = p.n && all ? Math.min(bw, Math.max(1, Math.round((p.n / all) * bw))) : 0
    rows.push(withPart([
      { s: on ? '▸' : ' ', tone: 'accent' }, { s: ' ' },
      { s: pad(cut(p.name, nw), nw), tone: tone(l, p.v), bold: on }, { s: '  ' },
      { s: (p.v === NONE ? FAINT : BAR).repeat(cells), tone: barTone(l, p.v) }, { s: ' '.repeat(bw - cells) },
      { s: lpad(num(p.n), 7), ...(p.n ? {} : { tone: 'dim' }), bold: on },
      { s: lpad(share100(p.n, all), 6), tone: 'dim' },
    ], valuePart(name, p.v)))
  }
  return rows
}

/** A label on one line: its name, a small bar of all its values, then each value and its count; `wrap` takes more
 *  lines for the values that do not fit, else … ends the line. */
function line(l, w, nameCol, wrap) {
  const name = String(l.name)
  const parts = partsOf(l)
  const counted = parts.some(p => p.n)
  const head = [{ s: pad(cut(name, nameCol - 1), nameCol), part: labelPart(name) }]
  const cells = share(parts.map(p => p.n), LINE_BAR)
  const bar = counted
    ? parts.map((p, i) => (cells[i] ? { s: (p.v === NONE ? FAINT : BAR).repeat(cells[i]), tone: barTone(l, p.v), part: labelPart(name) } : null)).filter(Boolean)
    : [{ s: pad('not run yet', LINE_BAR), tone: 'dim', part: labelPart(name) }]
  const x0 = nameCol + LINE_BAR + 2
  const rows = []
  let row = [...head, ...bar, { s: '  ' }]
  let x = x0
  const shown = openable(l)
  for (let i = 0; i < shown.length; i++) {
    const p = shown[i]
    const count = ` ${num(p.n)}`
    const seg = withPart([{ s: cut(p.name, Math.max(4, w - x0 - width(count) - 2)), tone: tone(l, p.v) }, { s: count, tone: 'dim' }], valuePart(name, p.v))
    const sw = runsWidth(seg)
    const room = i === shown.length - 1 ? w : w - 2
    if (x + (x > x0 ? 3 : 0) + sw > room && x > x0) {
      if (!wrap) { row.push({ s: x + 3 <= w ? '   …' : '…', tone: 'dim' }); break }
      rows.push(row)
      row = [{ s: ' '.repeat(x0) }]
      x = x0
    }
    if (x > x0) { row.push({ s: '   ' }); x += 3 }
    row.push(...seg)
    x += sw
  }
  rows.push(row)
  return rows
}

// ------------------------------------------------------------------------------------------------ examples

/** What names a record in its list: a table's row by its key (`#65559`); a line by who wrote it (its meta), else
 *  its number. */
export function whoOf(r) {
  const ref = String(r?.ref || '')
  const frag = ref.includes('#') ? ref.slice(ref.indexOf('#') + 1) : ''
  if (frag && !/^L\d+(-\d+)?$/.test(frag)) return `#${frag.split('/').filter(Boolean).pop() ?? frag}`
  if (r?.meta) return oneLine(r.meta)
  const m = /^L(\d+)/.exec(frag)
  return m ? `line ${m[1]}` : ref.split('/').pop()
}

/** A record's status at the right of its line: the person's check, that it waits for the model or got none, or the
 *  model's confidence. */
function statusOf(l, r) {
  if (r.checked) return [{ s: '✓ ', tone: 'dim' }, { s: String(r.value ?? ''), tone: tone(l, r.value) }]
  if (r.waiting) return [{ s: 'waits', tone: 'dim' }]
  if (r.error) return [{ s: '× no value', tone: 'err' }]
  if (r.by === 'model' && r.confidence != null) return [{ s: `${Math.round(100 * Number(r.confidence))}%`, tone: 'dim' }]
  return []
}

/** A record's words in `room` cells on one line: around the part its label matched (bold in `t`), the match within
 *  the first third unless the words after it are short; else its words, then the fields a code label read, dim. */
function snippet(r, t, room) {
  if (r.missing) return [{ s: cut(String(r.missing), room), tone: 'dim' }]
  if (r.hit) {
    const match = cut(oneLine(r.hit.match), Math.max(4, room - 4))
    const left = Math.max(0, room - width(match))
    const before = oneLine(r.hit.before, false).trimStart()
    const after = oneLine(r.hit.after, false).trimEnd()
    const third = Math.min(left, Math.max(8, Math.floor(room / 3)))
    const shown = cutWords(before, Math.min(width(before), Math.max(third, left - width(after))), 'end')
    return [{ s: shown }, { s: match, tone: t, bold: true }, { s: cutWords(after, left - width(shown), 'start') }]
  }
  const said = oneLine(r.words || r.text)
  const fields = fieldsOf(r, said)
  if (!fields) return [{ s: cutWords(said, room) }]
  const s = cutWords(said, Math.max(10, room - Math.min(width(fields), Math.floor(room / 2)) - 2))
  return [{ s }, { s: `  ${cut(fields, Math.max(0, room - width(s) - 2))}`, tone: 'dim' }]
}

/** The fields a code label read, unless the words already start with them. */
function fieldsOf(r, said) {
  if (!Array.isArray(r.fields)) return ''
  return r.fields.filter(f => !said.startsWith(oneLine(f[1]).slice(0, 40))).map(f => `${f[0]} ${oneLine(f[1])}`).join(' · ')
}

/** Runs wrapped at words into lines of `w` cells: a word longer than a line is cut across lines. */
export function wrapRuns(runs, w) {
  const lines = [[]]
  let x = 0
  const put = (s, r) => {
    const last = lines[lines.length - 1]
    const prev = last[last.length - 1]
    if (prev && prev.tone === r.tone && !!prev.bold === !!r.bold && !!prev.italic === !!r.italic) prev.s += s
    else last.push({ ...r, s })
    x += width(s)
  }
  for (const r of runs) {
    for (const tok of String(r.s).split(/(\s+)/)) {
      if (!tok) continue
      if (/^\s+$/.test(tok)) {
        if (x === 0) continue
        if (x + 1 > w) { lines.push([]); x = 0; continue }
        put(' ', r)
        continue
      }
      let word = tok
      if (x + width(word) > w && x > 0) {
        const last = lines[lines.length - 1]
        const tail = last[last.length - 1]
        if (tail && /\s$/.test(tail.s)) { tail.s = tail.s.replace(/\s+$/, ''); if (!tail.s) last.pop() }
        lines.push([])
        x = 0
      }
      while (width(word) > w) {
        let k = 0
        let cw = 0
        for (const ch of word) { if (cw + width(ch) > w) break; cw += width(ch); k += ch.length }
        put(word.slice(0, k), r)
        lines.push([])
        x = 0
        word = word.slice(k)
      }
      if (word) put(word, r)
    }
  }
  return lines.filter((l, i) => l.length || i === 0)
}

/** A picked record's words for its lines: around its match (at most two lines before it), else its words. */
function wholeRuns(r, t, lw) {
  if (r.missing) return [{ s: String(r.missing), tone: 'dim' }]
  if (r.hit) {
    // the words whole when they fit the lines, else cut before the match so it shows in the first two
    const whole = oneLine(r.hit.before, false).trimStart()
    const match = oneLine(r.hit.match)
    const after = oneLine(r.hit.after, false).trimEnd()
    const fits = width(whole) + width(match) + width(after) <= TEXT_LINES * (lw - 4)
    return [{ s: fits ? whole : cutWords(whole, 2 * lw, 'end') }, { s: match, tone: t, bold: true }, { s: after }]
  }
  const said = oneLine(r.words || r.text)
  const fields = fieldsOf(r, said)
  return fields ? [{ s: said }, { s: `  ${fields}`, tone: 'dim' }] : [{ s: said }]
}

/** The check keys of a picked record: 1–9 a value, and once the person checked it, their value and 0 to take the
 *  check back. */
function checkRuns(l, r) {
  const values = valuesOf(l).slice(0, 9)
  const out = r.checked ? [{ s: '✓ you: ', tone: 'dim' }, { s: String(r.value ?? ''), tone: tone(l, r.value), bold: true }, { s: '   ' }] : []
  values.forEach((v, i) => {
    if (i) out.push({ s: '  ' })
    out.push({ s: v, tone: tone(l, v), part: checkPart(v), hotkey: String(i + 1) })
  })
  if (r.checked) out.push({ s: '  ' }, { s: 'take back', tone: 'dim', part: checkPart(null), hotkey: '0' })
  return out
}

/** Runs split into rows of `w` cells at their gaps (a key and its value stay together). */
function flowRuns(runs, w, indent) {
  const units = []
  for (const r of runs) {
    if (!r.part && /^\s+$/.test(r.s)) units.push({ gap: r })
    else if (units.length && !units[units.length - 1].gap && !units[units.length - 1].runs.some(x => x.part)) units[units.length - 1].runs.push(r)
    else units.push({ runs: [r] })
  }
  const rows = []
  let row = []
  let x = 0
  for (const u of units) {
    if (u.gap) { if (row.length) { row.push(u.gap); x += width(u.gap.s) } continue }
    const uw = runsWidth(u.runs)
    if (x + uw > w && row.length) {
      while (row.length && !row[row.length - 1].part && /^\s+$/.test(row[row.length - 1].s)) row.pop()
      rows.push(row)
      row = []
      x = 0
    }
    row.push(...u.runs)
    x += uw
  }
  if (row.length) rows.push(row)
  return rows.map(r => [{ s: ' '.repeat(indent) }, ...r])
}

/** The rows a picked record opens to, after its first line: its words' other lines, where it is with the check keys,
 *  and what more there is to say of it (why no words are marked, the model's reason, an error). */
function pickedRows(l, r, t, o) {
  const lw = Math.max(10, o.w - o.x)
  const lines = wrapRuns(wholeRuns(r, t, lw), lw)
  const kept = lines.slice(0, TEXT_LINES)
  if (lines.length > TEXT_LINES) {
    const last = kept[kept.length - 1]
    const room = lw - runsWidth(last)
    if (room >= 1) last.push({ s: '…', tone: 'dim' })
    else { const tail = last[last.length - 1]; tail.s = `${cut(tail.s, Math.max(0, width(tail.s) - 1))}`.replace(/…$/, '') + '…' }
  }
  const indent = [{ s: ' '.repeat(o.x) }]
  const rows = kept.slice(1).map(k => [...indent, ...k])
  const place = o.place(r)
  const checks = r.missing ? [] : checkRuns(l, r)
  const cw = runsWidth(checks)
  if (!checks.length) rows.push([...indent, { s: cut(place, lw, true), tone: 'dim' }])
  else if (width(place) + 2 + cw <= lw) rows.push([...indent, ...spread([{ s: place, tone: 'dim' }], checks, lw)])
  else rows.push([...indent, { s: cut(place, lw, true), tone: 'dim' }], ...flowRuns(checks, lw, o.x))
  const note = (s, more = {}) => rows.push([...indent, { s: cut(oneLine(s), lw), tone: 'dim', ...more }])
  if (r.reason) note(`the model: ${r.reason}`, { italic: true })
  if (!r.hit && r.unmarked) note(r.unmarked)
  if (r.waiting) note('waits for the model to read it')
  if (r.error) rows.push([...indent, { s: cut(`× ${oneLine(r.error)}`, lw), tone: 'err' }])
  return { first: kept[0] || [], rows }
}

/** The examples of a value: their head (the value, its count, which of them show), then one line each, the picked one
 *  open, `↑ N earlier` and `↓ N more` where the list goes on. `page` is the kernel's page ({at, total, records});
 *  `rows` how many rows the examples have, their head included. Answers the rows, and where the list stands. */
export function examples(l, value, page, o) {
  const w = o.w
  const recs = Array.isArray(page?.records) ? page.records : []
  const part = partsOf(l).find(p => p.v === value)
  const total = Number(page?.total ?? part?.n) || 0
  const at = Math.max(0, Number(page?.at) || 0)
  const t = tone(l, value)
  const vname = part?.name ?? value
  const head = left => spread([{ s: vname, tone: t, bold: true }, { s: ` · ${num(total)}`, tone: 'dim' }], left, w)
  if (!total || !recs.length) return { rows: [head([]), [{ s: '  No record has this value.', tone: 'dim' }]], shown: [], at, from: at, last: at - 1, total, p: -1 }
  const whoW = Math.min(9, Math.max(4, ...recs.map(r => width(whoOf(r)))))
  const x = 2 + whoW + 2
  const status = recs.map(r => statusOf(l, r))
  const sw = Math.max(0, ...status.map(runsWidth))
  const room = Math.max(10, w - x - (sw ? sw + 2 : 0))
  const p = recs.findIndex(r => r.ref === o.sel)
  const picked = p >= 0 ? pickedRows(l, recs[p], t, { w, x, place: o.place }) : null
  const tall = i => (i === p ? 1 + picked.rows.length : 1)
  // the rows the list has: the head, then `↑ earlier` once it starts past the first record, and `↓ more` while records
  // follow the last one shown; the window starts where the picked record shows whole
  const avail = Math.max(1, o.rows - 1)
  let earlier = at > 0
  let more = false
  let s = 0
  let last = -1
  for (let k = 0; k < 4; k++) {
    const cap = Math.max(1, avail - (earlier ? 1 : 0) - (more ? 1 : 0))
    s = p >= 0 ? Math.max(0, Math.min(p, p + tall(p) - cap)) : 0
    if (s > 0 && !earlier) { earlier = true; continue }
    let used = 0
    last = s - 1
    for (let i = s; i < recs.length && used + tall(i) <= cap; i++) { used += tall(i); last = i }
    if (last < s) last = s
    if (total - (at + last + 1) > 0 && !more) { more = true; continue }
    break
  }
  const rows = [head([{ s: `${num(at + s + 1)}–${num(at + last + 1)} of ${num(total)}`, tone: 'dim' }])]
  if (earlier) rows.push([{ s: `  ↑ ${num(at + s)} earlier`, tone: 'dim', part: 'pg-up' }])
  for (let i = s; i <= last; i++) {
    const r = recs[i]
    const on = i === p
    const who = { s: pad(cut(whoOf(r), whoW), whoW), ...(on ? { bold: true } : { tone: 'dim' }) }
    const lead = [{ s: on ? '▸' : ' ', tone: 'accent' }, { s: ' ' }, who, { s: '  ' }]
    if (on) {
      rows.push(withPart([...lead, ...picked.first], recordPart(r.ref)))
      rows.push(...picked.rows)
      continue
    }
    const words = snippet(r, t, room)
    const used = x + runsWidth(words)
    rows.push(withPart([...lead, ...words, ...(sw ? [{ s: ' '.repeat(Math.max(2, w - used - runsWidth(status[i]))) }, ...status[i]] : [])], recordPart(r.ref)))
  }
  const after = total - (at + last + 1)
  if (after > 0) rows.push([{ s: `  ↓ ${num(after)} more`, tone: 'dim', part: 'pg-down' }])
  return { rows, shown: recs.slice(s, last + 1).map(r => r.ref), at, from: at + s, last: at + last, total, p }
}

/** The definition in place of the examples: its kind, the rule whole (a code label's as code), what it went over. */
export function definition(l, w, show = p => p) {
  const rows = [[{ s: 'definition', bold: true }, { s: ` · ${KIND[l.kind] ?? String(l.kind || '')}`, tone: 'dim' }]]
  const rule = String(l.rule || '').replace(/\s+$/, '')
  if (!rule) rows.push([{ s: '  no rule: Claude gave each record its value', tone: 'dim' }])
  else if (l.kind === 'code') rows.push({ code: rule })
  else for (const ln of rule.split('\n')) rows.push(...wrapRuns([{ s: ln }], Math.max(10, w - 2)).map(r => [{ s: '  ' }, ...r]))
  rows.push([])
  rows.push(...wrapRuns([{ s: scopeWords(l, show), tone: 'dim' }], w))
  return rows
}

// ------------------------------------------------------------------------------------------------ the view

/** Which label and value the pane shows: the label named (or the one label there is), on the value named, else its
 *  first value with records. Null at rest. */
export function chosenOf(list, args = {}) {
  const lab = args.label ? list.find(l => l.name === args.label) : list.length === 1 ? list[0] : null
  if (!lab) return null
  const picks = openable(lab)
  const value = picks.some(p => p.v === args.value) ? args.value : (picks.find(p => p.n)?.v ?? picks[0]?.v ?? NONE)
  return { lab, value }
}

/** Every value in reading order, as p n walk them: [label, value]. */
export function valueOrder(list) {
  return list.flatMap(l => openable(l).map(p => [String(l.name), p.v]))
}

/** The head and the labels: each a table when they all fit in `rows` (with the keys under them), else one line each;
 *  with a label chosen, its table in its place, a blank row around it, and the others one line each. */
export function ledgerTop(list, chosen, o) {
  const w = o.w
  const head = [{ s: 'Labels', bold: true }, { s: ` · ${list.length} label${list.length === 1 ? '' : 's'}`, tone: 'dim' }]
  const nameCol = Math.min(NAME_MAX + 2, Math.max(10, ...list.map(l => width(String(l.name)) + 2)))
  const rows = []
  if (!chosen) {
    const tall = list.reduce((s, l) => s + openable(l).length + 2, 0)
    if (tall - 1 <= o.rows) for (const l of list) rows.push(...block(l, null, w), [])
    else for (const l of list) rows.push(...line(l, w, nameCol, true))
    while (rows.length && !rows[rows.length - 1].length) rows.pop()
    return { head, rows }
  }
  list.forEach((l, i) => {
    if (l !== chosen.lab) { rows.push(...line(l, w, nameCol, false)); return }
    if (i) rows.push([])
    rows.push(...block(l, chosen.value, w), [])
  })
  if (rows.length && rows[rows.length - 1].length) rows.push([])
  return { head, rows }
}

/** A row as plain text, for the tests and for a check of its width. */
export function rowText(row) {
  if (!Array.isArray(row)) return row?.code ?? ''
  return row.map(r => (r.hotkey ? `${r.hotkey}: ${r.s}` : r.s)).join('')
}
