// labels.js: the label panel, a program on the card runtime (draw/kit.js) over the folder's labels (`thimble label
// --json`, engine/kernel/labels.py). It opens in the side panel (shell/side.ts openSide) as a thread: a question typed
// under it is about the label, value or record selected, and carries its refs. The bar's `N labels` opens the list (one
// label alone opens on itself), and the row beside a card or an answer that counts by a label opens that label
// (shell/labeluse.ts), with a value's records when the value was clicked.
//
// It opens on how the label is defined: its name, its kind (regex, code, or a prompt the model read each record
// against) and the whole definition under the head (the pattern, the code in color, or the prompt, wrapped). Then what
// it ran over (`14,591 records in revisions.jsonl`), its values over its records (each a bar and a count), and the
// examples of the value picked, one record at a time: the part the label matched marked (a regex's match on its line,
// the fields the code read), a long record cut to the stretch around the match, and a row of the values to check it
// with. The action above the input bar folds the definition (Definition). The colors are the label card's (labels.py
// CARD_PROGRAM), so a value reads the same on the card and here.
//
//   state: {open: the label open, from: 'list' when the list opened it (esc goes back there), filter: the value picked
//          ('-': the records with no value yet), rec: the example shown (its place among the value's records), at: the
//          part selected, fold: the definition folded}
//   presses: a label in the list opens it · a value picks it · the example opens as a citation, over this pane · a
//            value of the check row is the person's check of the example
//   actions: Definition (the definition shown or folded: `act:def:on` while shown)
//   keys: ↑ ↓ pick the value (the side panel walks the pane's own parts with them), [ ] flip its examples. ← and →
//         never reach a pane: Claude Code keeps them
//   wants: {records: name, value, at, n, gen} (a page of the records, read by the host)
//   asks of the host: check {label, ref, value} (the person's check), open {mark: {kind: 'cite', ref, label}} (a record
//          as a citation, over this pane)
import { subjectBlock } from './subject.js'

const PAGE = 20
// the rows the side panel takes under a pane: the way back, its input bar, and its thread's conversation when it has
// one (up to two fifths of the panel), so the records that fit show above them
const chromeOf = (k, chat) => 6 + (chat ? Math.floor(k.h * 0.4) : 0)
const NO_VALUE = '-'
const n = x => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))
const cut = (s, k) => (Array.from(String(s)).length <= k ? String(s) : Array.from(String(s)).slice(0, Math.max(0, k - 1)).join('') + '…')
const len = s => Array.from(String(s)).length
const pad = (s, k, right = false) => { const t = cut(s, k); const sp = ' '.repeat(Math.max(0, k - len(t))); return right ? sp + t : t + sp }

/** A value's tone, as the label card colors it: the first value the accent, the others the category tones. */
export function valueTone(values, v) {
  const i = (values || []).indexOf(v)
  if (v == null || v === NO_VALUE) return 'dim'
  if (i < 0) return 'c2'
  return i === 0 ? 'accent' : 'c' + ((i % 5) + 2)
}

// the tones that carry no color of their own (draw/palette.js)
const PLAIN = /^(ink|paper|dim|unseen|rule)(-faint)?$/

// the marks a legend puts before a value's name in the value's color (`■ agent`)
const SWATCH = /^[■●▪◼█▆▇▌◆▲]$/u

/** The tones a drawn card gives a label's values ({value: tone}): where a value first stands as a word of its own in
 *  a color (a legend, a bar's name), or in plain words after a mark in a color (`■ agent`), never on a fill. Empty when
 *  the card colors none of them. With the label's `name`, also the colors the card's program gave the label's values on
 *  its parts (a bar named `child`), which the drawing keeps (draw/kit.js labelTone, the grid's `labelTones`). */
export function tonesIn(grid, values, name) {
  const out = {}
  const given = name && grid && grid.labelTones && typeof grid.labelTones === 'object' ? grid.labelTones[name] : null
  if (given && typeof given === 'object') for (const v of values || []) if (typeof given[v] === 'string' && given[v]) out[v] = given[v]
  for (const [v, at] of Object.entries(spotsIn(grid, values))) out[v] = at.tone
  return out
}

/** Where a drawn card names a label's values in their colors, as tonesIn finds them: {value: {tone, y, x, w}}, the
 *  cells from the value's mark (or its first letter) to its last letter, so the shell can make each one a press that
 *  opens the label on that value. */
export function spotsIn(grid, values) {
  const out = {}
  const left = new Set((values || []).filter(v => typeof v === 'string' && v.trim()))
  ;((grid && grid.rows) || []).forEach((row, y) => {
    if (!left.size) return
    let text = ''
    const at = []
    row.forEach((c, i) => { if (c && !c.cont) { for (const ch of String(c.ch || ' ')) { text += ch; at.push(i) } } })
    for (const v of [...left]) {
      let i = text.indexOf(v)
      while (i >= 0) {
        const before = text[i - 1]
        const after = text[i + v.length]
        const word = !(before && /[\p{L}\p{N}_]/u.test(before)) && !(after && /[\p{L}\p{N}_]/u.test(after))
        const c = row[at[i]]
        const colored = x => x && x.tone && !PLAIN.test(x.tone) && !x.bg
        // the mark before it: one or two cells back, over a space
        const back = [1, 2].find(b => { const x = i - b >= 0 ? row[at[i - b]] : null; return !!x && !!String(x.ch).trim() })
        const mark = back ? row[at[i - back]] : null
        // (a mark's gray is a color it gives the value: only ink and paper are no color there)
        const swatch = x => x && x.tone && !/^(ink|paper)$/.test(x.tone) && !x.bg
        const marked = mark && SWATCH.test(String(mark.ch)) && swatch(mark)
        const tone = !word || !c || c.bg ? null : colored(c) ? c.tone : marked ? mark.tone : null
        if (tone) {
          const x = marked ? at[i - back] : at[i]
          out[v] = { tone, y, x, w: at[i + v.length - 1] + 1 - x }
          left.delete(v)
          break
        }
        i = text.indexOf(v, i + 1)
      }
    }
  })
  return out
}

/** A value's tone beside a card: the label's own (valueTone), the color a card made from the label's rows gives it too
 *  (shell/node/prep.mjs labelKeys). */
export function toneBeside(l, v) {
  return valueTone(l && l.values, v)
}

/** How a label was made, in a few plain words for the row beside a card and the panel's head: a regex, code, or Claude
 *  read each record (a model label, or values Claude gave records it read). */
export function howMade(kind) {
  if (kind === 'prompt' || kind === 'set') return 'read by Claude'
  if (kind === 'regex') return 'regex'
  if (kind === 'code') return 'code'
  return ''
}

/** A label's definition in one line of at most `room` columns, cut with … : the pattern, the start of the model's
 *  question, or the code's lines after its `def label(unit):`, joined as one line of Python (`; `, or a space after a
 *  `:`). Empty when it has none. */
export function defLine(l, room) {
  const def = String((l && l.rule) || '').trim()
  if (!def || room < 2) return ''
  const one = l.kind === 'code'
    ? def.split('\n').map(x => x.trim()).filter(x => x && !/^def\s+label\s*\(/.test(x)).reduce((s, x) => (!s ? x : s.endsWith(':') ? `${s} ${x}` : `${s}; ${x}`), '')
    : def.replace(/\s+/g, ' ')
  return cut(one, room)
}

/** What made a label, in plain words. */
export function madeBy(l) {
  const vs = l.values || []
  if (l.kind === 'prompt') return 'a model, reading each record against the definition'
  if (l.kind === 'regex') return `a rule: text that matches the pattern is ${vs[0]}, the rest ${vs[vs.length - 1]}`
  if (l.kind === 'code') return 'a rule in code: label(unit) gives each record its value'
  if (l.kind === 'set') return 'Claude, giving values to records it read'
  return String(l.kind || 'unknown')
}

/** How far a label is, in plain words with its counts: `3,104 records, all labeled`, `labeled 1,944 of 3,044 records ·
 *  1,100 waiting for the model`, `a trial on 40 of 14,591 records`, and the person's checks. */
export function stateWords(l) {
  const records = l.records || 0
  const valued = l.valued ?? Object.values(l.counts || {}).reduce((s, x) => s + x, 0)
  const parts = []
  if (l.trial) parts.push(`a trial on ${n(records)} of ${n(l.matched || records)} records`)
  if (!records) parts.push('no records yet')
  else if (valued >= records) parts.push(l.trial ? 'all labeled' : `${n(records)} records, all labeled`)
  else parts.push(`labeled ${n(valued)} of ${n(records)} records`)
  if (l.waiting) parts.push(`${n(l.waiting)} waiting for the model`)
  if (l.failed) parts.push(`${n(l.failed)} got no value`)
  if (l.checked) parts.push(`you checked ${n(l.checked)}`)
  return parts.join(' · ')
}

/** A label's parts as its bar and legend draw them: each value with records, then those still waiting for the model
 *  and those with no value. */
export function partsOf(l) {
  const counts = l.counts || {}
  const values = [...(l.values || []), ...Object.keys(counts).filter(v => !(l.values || []).includes(v))]
  const out = values.filter(v => counts[v] > 0).map(v => ({ name: v, n: counts[v], tone: valueTone(l.values, v), mark: '█' }))
  if (l.waiting) out.push({ name: 'not labeled yet', n: l.waiting, tone: 'unseen', mark: '░' })
  if (l.failed) out.push({ name: 'no value', n: l.failed, tone: 'dim', mark: '░' })
  return out
}

/** `cells` shared by `weights` (largest remainders), each non-zero weight at least one cell while there are enough. */
function share(weights, cells) {
  const total = weights.reduce((s, x) => s + x, 0)
  if (!total || cells <= 0) return weights.map(() => 0)
  const exact = weights.map(x => (x * cells) / total)
  const out = exact.map(Math.floor)
  const order = exact.map((c, i) => ({ i, r: c - Math.floor(c) })).sort((a, b) => b.r - a.r)
  for (let k = 0, left = cells - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k % order.length].i]++
  if (weights.filter(x => x > 0).length <= cells) weights.forEach((x, i) => { if (x > 0 && !out[i]) { const big = out.reduce((b, c, j) => (c > out[b] ? j : b), 0); out[big]--; out[i] = 1 } })
  return out
}

/** A label's stacked bar of its values in `w` cells, as markup. */
function stacked(parts, w) {
  const cells = share(parts.map(p => p.n), w)
  return parts.map((p, i) => (cells[i] ? `{${p.tone}:${p.mark.repeat(cells[i])}}` : '')).join('')
}

/** The label the pane shows: the one open, else the only one there is. */
function shownLabel(data, st) {
  const list = data.list || []
  if (st.open) return list.find(l => l.name === st.open) || null
  return list.length === 1 ? list[0] : null
}

export default {
  name: 'labels',
  title: 'Labels',
  // the ring starts on the label (or the record) selected, so ↵ opens it at once, as a click does; a letter still starts
  // a question
  ringStart: 'part',
  local: ['at'],
  reads: () => ['labels'],
  stateKey: () => 'labels',
  /** What a question asked under the pane is about, beyond the part selected (side.ts paneSubject). */
  thread(_args, state, data) {
    const lab = data && Array.isArray(data.list) ? shownLabel(data, state || {}) : null
    if (!lab) return { about: `the folder's labels (\`thimble label\`): ${((data && data.list) || []).map(l => l.name).join(', ') || 'none yet'}` }
    const counts = (lab.values || []).map(v => `${v} ${n((lab.counts || {})[v] || 0)}`).join(', ')
    return { about: `the label ${lab.name}, made by ${madeBy(lab)}, over ${lab.in || 'the records Claude named'}: ${n(lab.records || 0)} records (${counts}${lab.waiting ? `, ${n(lab.waiting)} waiting for the model` : ''})${lab.checked ? `; the analyst checked ${n(lab.checked)}` : ''}${state && state.filter ? `; its records filtered to ${state.filter === NO_VALUE ? 'those with no value yet' : state.filter}` : ''}. \`thimble label ${lab.name}\` shows it` }
  },
  data(stores, _args, size) {
    const s = stores.labels || {}
    // gen: how many checks the person made, so a page of records is read again after one
    return { list: Array.isArray(s.list) ? s.list : null, error: s.error || null, gen: Number(s.checks) || 0, refreshing: !!s.loading, chat: !!s.chat, w: size.w, h: size.h }
  },
  program,
}

export function program(k, data) {
  if (!data.list) {
    if (data.error) return k.text(`{bad:×} the labels could not be read: ${k.escape(data.error)}`)
    return k.text('{dim:◌ reading the labels…}')
  }
  const st = k.state || {}
  const W = Math.max(40, k.w)
  const lab = shownLabel(data, st)
  if (!lab) return listView(k, data, st, W)
  return labelView(k, data, st, lab, W)
}

// ------------------------------------------------------------------------------------------------ the labels list

function listView(k, data, st, W) {
  const list = data.list
  const ids = list.map((_, i) => `lb-${i}`)
  const at = ids.includes(st.at) ? st.at : ids[0] || null
  const idx = ids.indexOf(at)
  const open = i => (list[i] ? { open: list[i].name, from: 'list', filter: null, rec: 0, at: null } : null)
  k.on('focus', e => (e.region && ids.includes(e.region) ? { at: e.region } : null))
  k.on('press', e => (ids.includes(e.region) ? open(ids.indexOf(e.region)) : null))
  // → opens the label selected, as ↵ does
  k.on('right', () => (idx >= 0 ? open(idx) : null))
  if (at) k.select(at)
  const head = subjectBlock(k, { title: 'Labels', line: `${n(list.length)} label${list.length === 1 ? '' : 's'} in this folder${data.refreshing ? ' · ◌' : ''}` })
  if (!list.length) return k.stack(head, k.text('{dim:No labels here yet. When Claude sorts records into categories, it makes a label, and the label shows here.}'))
  const longest = Math.min(28, Math.max(...list.map(l => len(l.name))))
  const tw = Math.max(...list.map(l => n(l.records || 0).length))
  const bw = Math.max(8, Math.min(40, W - 4 - longest - 2 - tw - 10))
  const blocks = []
  list.forEach((l, i) => {
    const parts = partsOf(l)
    const on = i === idx
    const glyph = l.waiting && !(l.records - l.waiting) ? '{unseen:◌}' : `{${valueTone(l.values, (l.values || [])[0])}:●}`
    const name = k.escape(pad(l.name, longest))
    const bar = parts.length ? stacked(parts, bw) : `{dim:${pad('not run yet', bw)}}`
    const row = `${glyph} ${on ? `**${name}**` : name}  ${bar}  ${pad(n(l.records || 0), tw, true)} {dim:records}`
    blocks.push(k.region(`lb-${i}`, { label: `the label ${l.name}: ${n(l.records || 0)} records`, ...(l.query ? { ref: `${l.query}#${l.name}=${l.values[0]}@n` } : {}) },
      k.stack(k.text(row, { wrap: false }), k.text(`  ${parts.map(p => `{${p.tone}:${p.mark === '█' ? '●' : p.mark}} ${k.escape(p.name)} {dim:${n(p.n)}}`).join('   ')}`, { wrap: false }))))
  })
  // two rows a label: as many as fit, from the one selected
  const room = Math.max(2, Math.floor((k.h - 4 - chromeOf(k, data.chat)) / 2))
  const top = Math.max(0, Math.min(list.length - room, idx - room + 2))
  const shown = blocks.slice(top, top + room)
  return k.stack(head, ...shown, ...(list.length > top + room ? [k.text(`{dim:↓ ${n(list.length - top - room)} more}`)] : []))
}

// ------------------------------------------------------------------------------------------------ one label

function labelView(k, data, st, lab, W) {
  const values = lab.values || []
  const counts = lab.counts || {}
  const none = (lab.waiting || 0) + (lab.failed || 0)
  // the values to pick from (↑ ↓): each of the label's, then the records with no value yet when there are some
  const picks = [...values, ...(none ? [NO_VALUE] : [])]
  const first = values.find(v => counts[v] > 0) ?? picks[0] ?? null
  const filter = picks.includes(st.filter) ? st.filter : first
  const total = filter == null ? 0 : filter === NO_VALUE ? none : counts[filter] || 0
  const rec = Math.max(0, Math.min(total - 1, Number(st.rec) || 0))
  const pageAt = Math.floor(rec / PAGE) * PAGE
  const got = total ? k.want({ records: lab.name, value: filter, at: pageAt, n: PAGE, gen: data.gen }) : null
  const recs = got && Array.isArray(got.records) ? got.records : []
  const cur = recs.find(r => r.i === rec) || null
  const idOf = v => (v === NO_VALUE ? 'filter-none' : `val-${values.indexOf(v)}`)

  // ---- what the person does: ↑ ↓ pick the value, [ ] flip its examples, a press on a value picks it, on the example
  // opens it as a citation, on a value of the check row checks it
  const pick = v => ({ filter: v, rec: 0, at: idOf(v) })
  const step = d => {
    const i = picks.indexOf(filter)
    const j = Math.max(0, Math.min(picks.length - 1, i + d))
    return j === i ? { at: idOf(filter) } : pick(picks[j])
  }
  const flip = d => (total ? { rec: (rec + d + total) % total, at: idOf(filter) } : null)
  k.on('up', () => step(-1))
  k.on('down', () => step(1))
  k.on('[', () => flip(-1), 'previous / next example')
  k.on(']', () => flip(1))
  const citeOf = r => ({ kind: 'cite', ref: r.ref, label: `${lab.name} = ${r.value ?? 'no value'}: ${place(r.ref)}` })
  k.on('focus', e => {
    const r = String(e.region || '')
    if (r === 'filter-none') return filter === NO_VALUE ? { at: r } : pick(NO_VALUE)
    const v = /^val-(\d+)$/.exec(r)
    if (v) return values[Number(v[1])] === filter ? { at: r } : pick(values[Number(v[1])])
    return r ? { at: r } : null
  })
  k.on('press', e => {
    const r = String(e.region || '')
    if (r === 'filter-none') return pick(NO_VALUE)
    const v = /^val-(\d+)$/.exec(r)
    if (v) return pick(values[Number(v[1])])
    const c = /^chk-(\d+)$/.exec(r)
    if (c && cur && !cur.missing) {
      const value = values[Number(c[1])]
      k.do('check', { label: lab.name, ref: cur.ref, value })
      // the next example, unless the check moved this one out of the value (the next takes its place)
      const next = filter !== value ? rec : Math.min(Math.max(0, total - 1), rec + 1)
      return { rec: next, at: r }
    }
    if (r === 'example' && cur && !cur.missing) { k.do('open', { mark: citeOf(cur) }); return { at: r } }
    return null
  })
  // the action above the input bar: the definition shown or folded
  const hasDef = !!String(lab.rule || '').trim()
  const shown = hasDef && !st.fold
  if (hasDef) k.on(shown ? 'act:def:on' : 'act:def', () => ({ fold: shown }), 'Definition')
  // esc goes back to the list when the list opened this label; else the panel's esc (back, or close)
  // (← does the same where it reaches the pane, as in the browser)
  if (st.from === 'list' && (data.list || []).length > 1) {
    const back = () => ({ open: null, from: null, filter: null, rec: 0, at: null })
    k.on('esc', back, 'labels')
    k.on('left', back)
  }
  const keep = /^(chk-\d+|example)$/.test(String(st.at || ''))
  k.select(keep ? st.at : idOf(filter))

  const out = []
  // ---- the subject: the label, how it is defined (its kind, then the whole pattern, code or prompt), and what it ran
  // over
  const defs = shown ? defRows(k, lab, W) : []
  out.push(subjectBlock(k, {
    glyph: `{${valueTone(values, values[0])}:●}`,
    title: k.escape(lab.name),
    line: `${k.escape(kindWords(lab.kind))}${data.refreshing ? ' · ◌' : ''}`,
    rows: [...defs, ...(defs.length ? [k.text(' ')] : []), k.text(k.escape(ranOver(lab)), { wrap: false })],
  }))

  // ---- the values: each its color, bar, count and share; ↑ ↓ or a press picks one, and its examples show below
  const vw = Math.min(24, Math.max(4, ...values.map(len), none ? 15 : 0))
  const bw = Math.max(6, Math.min(30, W - 4 - vw - 2 - 14 - 12))
  const max = Math.max(1, ...values.map(v => counts[v] || 0), none)
  const valueRow = (id, label, tone, mark, c, on) => {
    const cells = c ? Math.max(1, Math.round((c / max) * bw)) : 0
    const row = `{${tone}:${mark}} ${on ? `**${k.escape(pad(label, vw))}**` : k.escape(pad(label, vw))}  {${tone}:${'█'.repeat(cells)}}${' '.repeat(bw - cells)}  ${pad(n(c), 7, true)} {dim:${pad(lab.records ? pctOf(c / lab.records) : '', 4, true)}}`
    const value = id.startsWith('val-') ? values[Number(id.slice(4))] : null
    // a value carries the citation of its count (the label's count query), so a question about it names its records
    const ref = value != null && lab.query && /^[\w.-]+$/.test(lab.name) && /^[\w.-]+$/.test(value) ? `${lab.query}#${lab.name}=${value}@n` : null
    return k.region(id, { label: `${lab.name} = ${label}: ${n(c)} records`, ...(ref ? { ref } : {}) }, k.text(row, { wrap: false }))
  }
  values.forEach((v, i) => out.push(valueRow(`val-${i}`, v, valueTone(values, v), '●', counts[v] || 0, filter === v)))
  if (none) out.push(valueRow('filter-none', lab.waiting ? 'not labeled yet' : 'no value', 'unseen', '░', none, filter === NO_VALUE))
  out.push(k.text(' '))

  // ---- the examples of the value picked: one record at a time, its matched part marked
  if (filter == null) return k.stack(out)
  const vname = filter === NO_VALUE ? (lab.waiting ? 'not labeled yet' : 'no value') : filter
  out.push(k.beside(
    k.text(`{dim:examples ·} {${filter === NO_VALUE ? 'unseen' : valueTone(values, filter)}:● ${k.escape(vname)}}`, { wrap: false }),
    k.text(total ? `${n(rec + 1)} {dim:of} ${n(total)}  {dim:[ ] flip · ↑ ↓ value}` : ' ', { grow: 1, wrap: false, align: 'right' }),
    { gap: 1 },
  ))
  if (!total) { out.push(k.text('{dim:  no record has this value}')); return k.stack(out) }
  if (!got) { out.push(k.text('{dim:  reading the records…}')); return k.stack(out) }
  if (got.error) { out.push(k.text(`{bad:  × ${k.escape(got.error)}}`)); return k.stack(out) }
  if (cur) out.push(...exampleView(k, lab, cur, W, chromeOf(k, data.chat)))
  return k.stack(out)
}

/** A label's kind in a word or two, for the panel's head. */
function kindWords(kind) {
  if (kind === 'regex') return 'regex'
  if (kind === 'code') return 'code (Python)'
  if (kind === 'prompt') return 'prompt: the model read each record'
  if (kind === 'set') return 'set by Claude, after reading'
  return String(kind || '')
}

/** What a label ran over: `14,591 records in revisions.jsonl`, with how far it is when it is not done. */
function ranOver(lab) {
  const parts = [`${n(lab.records || 0)} record${lab.records === 1 ? '' : 's'} in ${scopeOf(lab)}`]
  if (lab.trial) parts.push(`a trial sample of ${n(lab.matched || lab.records || 0)}`)
  if (lab.waiting) parts.push(`${n(lab.waiting)} waiting for the model`)
  if (lab.failed) parts.push(`${n(lab.failed)} got no value`)
  if (lab.disagree) parts.push(`${n(lab.disagree)} corrected by you`)
  return parts.join(' · ')
}

/** The records a label is over, in words: its glob, and where it keeps only some of them. */
function scopeOf(lab) {
  return [lab.in || 'the records Claude named', lab.where ? `where ${lab.where}` : '', lab.within ? `within ${lab.within[0]} = ${lab.within[1]}` : ''].filter(Boolean).join(' ')
}

// the most rows of a definition the panel shows, past which `thimble label NAME` prints it
const DEF_WHOLE = 40

/** A label's definition under the panel's head, whole, wrapped at the panel's width: the pattern, the code (its
 *  Python in color), or the model's question. */
function defRows(k, lab, W) {
  const def = String(lab.rule || '').replace(/\s+$/, '')
  if (!def.trim()) return []
  const w = Math.max(20, W - 2)
  const rows = lab.kind === 'prompt' ? wrap(def.replace(/\s+/g, ' ').trim(), w) : wrap(def, w)
  const tone = lab.kind === 'prompt' ? 'ink' : 'c1'
  const out = rows.slice(0, DEF_WHOLE).map(r => k.text(lab.kind === 'code' ? pyLine(k, r) || ' ' : `{${tone}:${k.escape(r)}}`, { wrap: false }))
  if (rows.length > DEF_WHOLE) out.push(k.text(`{dim:… ${n(rows.length - DEF_WHOLE)} more lines: thimble label ${k.escape(lab.name)}}`, { wrap: false }))
  return out
}

/** A record's ref as its place: its file's path in the folder and its line, `chat/room.jsonl:44`. Files of the same
 *  name in different folders (`labels/v2.md`, `notes/v2.md`) stay apart. Given `w`, a longer place is cut from the
 *  left, at a folder where it can be, so the file's name and line stay: `…/labels/v2.md:1`. */
export function place(ref, w = 0) {
  const s = String(ref)
  const at = s.indexOf('#')
  const path = at < 0 ? s : s.slice(0, at)
  const frag = at < 0 ? '' : s.slice(at + 1)
  const m = /^L(\d+)/.exec(frag)
  const whole = m ? `${path}:${m[1]}` : frag ? `${path}#${frag}` : path
  if (!w || len(whole) <= w) return whole
  const chars = Array.from(whole)
  const tail = chars.slice(chars.length - (w - 1)).join('')
  const slash = tail.indexOf('/')
  return '…' + (slash >= 0 && slash < tail.length - 1 ? tail.slice(slash) : tail)
}

/** Where a record's value comes from, in a word or two: `model 0.92`, `regex`, `you ✓`, `you (was no)`. */
export function byWords(r) {
  if (r.checked) return r.was != null && r.was !== r.value ? `you (was ${r.was})` : 'you ✓'
  if (r.waiting) return 'the model'
  if (r.by === 'model') return typeof r.confidence === 'number' ? `model ${r.confidence.toFixed(2)}` : 'model'
  return String(r.by || '')
}

/** The example shown: its place, its value and where the value came from, the part the label matched (a regex's
 *  match with the words around it, the fields the code read; or the record's start, for a model's label, with its
 *  reason), and the values to check it with (each a press). A long record shows only the stretch around the match,
 *  cut with …. */
function exampleView(k, lab, r, W, chrome) {
  const tone = r.value == null ? 'dim' : valueTone(lab.values, r.value)
  const mark = r.value == null ? 'accent' : tone
  const head = `{dim:${k.escape(place(r.ref, Math.max(20, W - 40)))}} · {${tone}:● ${k.escape(r.value == null ? (r.waiting ? 'not labeled yet' : 'no value') : r.value)}} {dim:· ${k.escape(byLong(r))}}`
  const rows = []
  const w = Math.max(20, W - 4)
  // at most this many rows of the record, so the check row stays on the screen
  const most = Math.max(3, Math.min(10, k.h - chrome - 22))
  if (r.hit) {
    rows.push(...markedRows(k, [[r.hit.before, false], [r.hit.match, true], [r.hit.after, false]], w, most, mark))
  } else if (Array.isArray(r.fields) && r.fields.length) {
    for (const [name, value] of r.fields) rows.push(...markedRows(k, [[name, true], [`: ${value}`, false]], w, 2, mark))
  } else {
    const text = String(r.text || r.words || r.missing || '').replace(/\r/g, '').replace(/\n{2,}/g, '\n')
    rows.push(...markedRows(k, [[text, false]], w, Math.min(most, 5), mark))
  }
  const out = [k.region('example', { label: `${place(r.ref)}, an example of ${lab.name} = ${r.value ?? 'no value'}`, ref: r.ref },
    k.stack(k.text(head, { wrap: false }), ...rows.map(x => k.beside(k.text('{dim:│} ', { wrap: false }), x, { gap: 0 }))))]
  if (r.reason) out.push(k.text(`{dim:why: ${k.escape(cut(String(r.reason).replace(/\s+/g, ' '), W - 6))}}`, { wrap: false }))
  if (r.error) out.push(k.text(`{bad:× ${k.escape(cut(r.error, W - 4))}}`, { wrap: false }))
  if (!r.missing) {
    // the person's check: the value they say it has (the one it has now reads as agreeing)
    const vs = (lab.values || []).slice(0, 9)
    out.push(k.text(' '))
    out.push(k.beside(
      k.text('{dim:your check:}', { wrap: false }),
      ...vs.map((v, i) => k.region(`chk-${i}`, { label: `check: ${v}` }, k.text(`{${valueTone(lab.values, v)}:●} ${v === r.value ? `**${k.escape(v)}**` : k.escape(v)}`, { wrap: false }))),
      { gap: 2 },
    ))
  }
  return out
}

/** Pieces of text ([[words, marked]]) wrapped at `w` columns into at most `most` rows (the last cut with …), the
 *  marked ones bold in `tone`. Words break at a space where they can; a newline starts a row. */
function markedRows(k, pieces, w, most, tone) {
  const chars = []
  for (const [s, on] of pieces) for (const ch of Array.from(String(s ?? ''))) chars.push([ch === '\t' ? ' ' : ch, on])
  const spans = []
  let i = 0
  while (i < chars.length) {
    let j = Math.min(chars.length, i + w)
    const nl = chars.slice(i, j).findIndex(c => c[0] === '\n')
    if (nl >= 0) { spans.push([i, i + nl]); i += nl + 1; continue }
    if (j < chars.length) { let b = j; while (b > i && chars[b][0] !== ' ') b--; if (b > i) j = b }
    spans.push([i, j])
    i = j
    while (i < chars.length && chars[i][0] === ' ') i++
  }
  // the rows from the one before the first marked row, where it would be past the last row shown
  const hit = spans.findIndex(([a, b]) => chars.slice(a, b).some(c => c[1]))
  const from = hit >= most ? hit - 1 : 0
  const shown = spans.slice(from, from + most)
  const more = from + most < spans.length
  return shown.map(([a, b], y) => {
    const row = chars.slice(a, b)
    if (from && !y && row[0] && row[0][0] !== '…') { row.unshift(['…', false]); while (row.length > w) row.splice(1, 1) }
    if (more && y === shown.length - 1) { while (row.length >= w) row.pop(); row.push(['…', false]) }
    let s = ''
    let run = ''
    let on = null
    const flush = () => { if (run) s += on ? `{${tone}:**${k.escape(run)}**}` : k.escape(run); run = '' }
    for (const [ch, m] of row) { if (m !== on) { flush(); on = m } run += ch }
    flush()
    return k.text(s || ' ', { wrap: false })
  })
}

// Python's words that the code's definition draws in the accent, its strings and numbers in their own tones, and its
// comments dim
const PY_WORDS = new Set('and as assert break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' '))

/** A line of Python as markup: its keywords, strings, numbers and comments in their tones. */
function pyLine(k, line) {
  let s = ''
  let i = 0
  const a = Array.from(line)
  while (i < a.length) {
    const ch = a[i]
    if (ch === '#') { s += `{dim:${k.escape(a.slice(i).join(''))}}`; break }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < a.length && a[j] !== ch) j += a[j] === '\\' ? 2 : 1
      s += `{c3:${k.escape(a.slice(i, j + 1).join(''))}}`
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < a.length && /\w/.test(a[j])) j++
      const word = a.slice(i, j).join('')
      // (a string's prefix, such as r'…' or f"…", goes with the string)
      if (/^[rbfuRBFU]{1,2}$/.test(word) && (a[j] === '"' || a[j] === "'")) { s += `{c3:${k.escape(word)}}`; i = j; continue }
      s += PY_WORDS.has(word) ? `{accent:${word}}` : k.escape(word)
      i = j
      continue
    }
    if (/\d/.test(ch)) {
      let j = i
      while (j < a.length && /[\d.]/.test(a[j])) j++
      s += `{c5:${a.slice(i, j).join('')}}`
      i = j
      continue
    }
    s += k.escape(ch)
    i++
  }
  return s
}

function byLong(r) {
  if (r.checked) return r.was != null && r.was !== r.value ? `you changed it (the label said ${r.was})` : 'you agreed'
  if (r.waiting) return 'the model has not read it yet'
  if (r.by === 'model') return `the model${typeof r.confidence === 'number' ? `, ${Math.round(r.confidence * 100)}% sure` : ''}`
  if (r.by === 'regex') return 'the pattern'
  if (r.by === 'code') return 'the code'
  if (r.by === 'claude') return 'Claude'
  return String(r.by || '')
}

const pctOf = p => (p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`)

/** Words wrapped at `w` columns, each line of the text on its own. */
function wrap(text, w) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (len(line + word) > w && line.trim()) { out.push(line.trimEnd()); line = word.trimStart() } else line += word
      while (len(line) > w) { out.push(Array.from(line).slice(0, w).join('')); line = Array.from(line).slice(w).join('') }
    }
    out.push(line.trimEnd())
  }
  return out
}
