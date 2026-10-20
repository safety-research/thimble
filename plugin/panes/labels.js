// labels.js: the label panel, a program on the card runtime (draw/kit.js) over the folder's labels (`thimble label
// --json`, engine/kernel/labels.py). It opens in the side panel (shell/side.ts openSide) as a thread: a question typed
// under it is about the label, value or record selected, and carries its refs. The bar's `N labels` opens the list (one
// label alone opens on itself), and the row beside a card or an answer that counts by a label opens that label
// (shell/labeluse.ts), with a value's records when the value was clicked.
//
// It opens on what the label tells: its values over its records (each a bar and a count, a press filters the records to
// it), then the records themselves with their values in color, the one selected whole, and a row of the values to
// check it with. How the label was made (a rule or a model, its definition) and where Claude made it are actions
// above the input bar, in words (Definition, Where Claude made it): the definition opens as the `side:opened` region, which
// the side panel draws right above them. The colors are the label card's (labels.py CARD_PROGRAM), so a value reads
// the same on the card and here.
//
//   state: {open: the label open, from: 'list' when the list opened it (esc goes back there), filter: the value its
//          records are filtered to ('-': no value yet), rec: the record selected (its place among the filtered ones),
//          at: the part selected, def: the definition shown}
//   presses: a label in the list opens it · a value filters the records to it (again: every record) · a record opens
//            it as a citation, over this pane · a value of the check row is the person's check of the record selected
//   actions: Definition (how it was made, and its definition, open or closed: `act:def:on` while open) · Where Claude
//            made it (the label's card in the conversation)
//   keys: none of its own. The side panel's ring walks the parts (↑ ↓, tab), ↵ presses the one it is on, esc goes back
//   wants: {records: name, value, at, n, gen} (a page of the records, read by the host)
//   asks of the host: check {label, ref, value} (the person's check), open {mark: {kind: 'cite', ref, label}} (a record
//          as a citation, over this pane), reveal {card} (the label's card in the conversation)
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
 *  the card colors none of them. */
export function tonesIn(grid, values) {
  const out = {}
  const left = new Set((values || []).filter(v => typeof v === 'string' && v.trim()))
  for (const row of (grid && grid.rows) || []) {
    if (!left.size) break
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
        const mark = [1, 2].map(b => (i - b >= 0 ? row[at[i - b]] : null)).find(x => x && String(x.ch).trim())
        const tone = !word || !c || c.bg ? null : colored(c) ? c.tone : mark && SWATCH.test(String(mark.ch)) && colored(mark) ? mark.tone : null
        if (tone) { out[v] = tone; left.delete(v); break }
        i = text.indexOf(v, i + 1)
      }
    }
  }
  return out
}

/** A value's tone beside a card: the card's own color for it when the card colors the label's values (`tones`, from
 *  tonesIn), plain for a value it leaves plain; else the label's (valueTone). */
export function toneBeside(l, v) {
  const t = (l && l.tones) || {}
  if (Object.keys(t).length) return t[v] || 'ink'
  return valueTone(l && l.values, v)
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
  const open = i => (list[i] ? { open: list[i].name, from: 'list', filter: null, rec: 0, at: null, def: false } : null)
  k.on('focus', e => (e.region && ids.includes(e.region) ? { at: e.region } : null))
  k.on('press', e => (ids.includes(e.region) ? open(ids.indexOf(e.region)) : null))
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
  const filter = st.filter === NO_VALUE ? (none ? NO_VALUE : null) : values.includes(st.filter) ? st.filter : null
  const total = filter == null ? lab.records || 0 : filter === NO_VALUE ? none : counts[filter] || 0
  const rec = Math.max(0, Math.min(total - 1, Number(st.rec) || 0))
  const pageAt = Math.floor(rec / PAGE) * PAGE
  const got = total ? k.want({ records: lab.name, value: filter == null ? '*' : filter, at: pageAt, n: PAGE, gen: data.gen }) : null
  const recs = got && Array.isArray(got.records) ? got.records : []
  const cur = recs.find(r => r.i === rec) || null

  // ---- what the person does: every part is a press, and the ring on a part selects it
  const setFilter = v => ({ filter: filter === v ? null : v, rec: 0, at: v === NO_VALUE ? 'filter-none' : `val-${values.indexOf(v)}` })
  const citeOf = r => ({ kind: 'cite', ref: r.ref, label: `${lab.name} = ${r.value ?? 'no value'}: ${place(r.ref)}` })
  k.on('focus', e => {
    const m = /^rec-(\d+)$/.exec(String(e.region || ''))
    if (m) return { rec: Number(m[1]), at: e.region }
    return e.region ? { at: e.region } : null
  })
  k.on('press', e => {
    const r = String(e.region || '')
    // (show all goes once pressed: the first record takes the selection, so a question is never about the press)
    if (r === 'filter-all') return { filter: null, rec: 0, at: null }
    if (r === 'filter-none') return setFilter(NO_VALUE)
    const v = /^val-(\d+)$/.exec(r)
    if (v) return setFilter(values[Number(v[1])])
    const c = /^chk-(\d+)$/.exec(r)
    if (c && cur && !cur.missing) {
      const value = values[Number(c[1])]
      k.do('check', { label: lab.name, ref: cur.ref, value })
      // the next record is selected, unless the check moved this one out of the filter (the next takes its place)
      const next = filter != null && filter !== value ? rec : Math.min(Math.max(0, total - 1), rec + 1)
      return { rec: next, at: `rec-${next}` }
    }
    // a record opens as a citation, over this pane: its row in its file
    const m = /^rec-(\d+)$/.exec(r)
    if (m) {
      const one = recs.find(x => x.i === Number(m[1]))
      if (one && !one.missing) k.do('open', { mark: citeOf(one) })
      return { rec: Number(m[1]), at: r }
    }
    return null
  })
  // the actions above the input bar: how it was made, and where Claude made it
  k.on(st.def ? 'act:def:on' : 'act:def', () => ({ def: !st.def }), 'Definition')
  if (lab.card) k.on('act:made', () => { k.do('reveal', { card: lab.card }); return null }, 'Where Claude made it')
  // esc closes the definition, then goes back to the list when the list opened this label; else the panel's esc
  // (back, or close)
  if (st.def) k.on('esc', () => ({ def: false }), lab.name)
  else if (st.from === 'list' && (data.list || []).length > 1) k.on('esc', () => ({ open: null, from: null, filter: null, rec: 0, at: null, def: false }), 'labels')
  const at = st.at || `rec-${rec}`
  k.select(at)

  const out = []
  // ---- the subject: the label, and how far it is in plain words
  out.push(subjectBlock(k, {
    glyph: `{${valueTone(values, values[0])}:●}`,
    title: k.escape(lab.name),
    line: `label over ${k.escape(lab.in || 'the records Claude named')} · ${k.escape(stateWords(lab))}${data.refreshing ? ' · ◌' : ''}`,
  }))

  // ---- the values: each its color, bar, count and share; a press filters the records to it
  const vw = Math.min(24, Math.max(4, ...values.map(len), none ? 15 : 0))
  const bw = Math.max(6, Math.min(30, W - 4 - vw - 2 - 14 - 12))
  const max = Math.max(1, ...values.map(v => counts[v] || 0), none)
  const valueRow = (id, label, tone, mark, c, on) => {
    const cells = c ? Math.max(1, Math.round((c / max) * bw)) : 0
    const row = `{${tone}:${mark}} ${on ? `**${k.escape(pad(label, vw))}**` : k.escape(pad(label, vw))}  {${tone}:${'█'.repeat(cells)}}${' '.repeat(bw - cells)}  ${pad(n(c), 7, true)} {dim:${pad(lab.records ? pctOf(c / lab.records) : '', 4, true)}}${on ? '  {accent:the records below}' : ''}`
    const value = id.startsWith('val-') ? values[Number(id.slice(4))] : null
    // a value carries the citation of its count (the label's count query), so a question about it names its records
    const ref = value != null && lab.query && /^[\w.-]+$/.test(lab.name) && /^[\w.-]+$/.test(value) ? `${lab.query}#${lab.name}=${value}@n` : null
    return k.region(id, { label: `${lab.name} = ${label}: ${n(c)} records`, ...(ref ? { ref } : {}) }, k.text(row, { wrap: false }))
  }
  values.forEach((v, i) => out.push(valueRow(`val-${i}`, v, valueTone(values, v), '●', counts[v] || 0, filter === v)))
  if (none) out.push(valueRow('filter-none', lab.waiting ? 'not labeled yet' : 'no value', 'unseen', '░', none, filter === NO_VALUE))
  out.push(k.text(' '))

  // ---- the records: which ones, the list around the one selected, and that one whole
  const which = filter == null ? `{dim:records ·} all ${n(total)}` : `{dim:records ·} {${valueTone(values, filter)}:${k.escape(filter === NO_VALUE ? (lab.waiting ? 'not labeled yet' : 'no value') : filter)}} ${n(total)}`
  out.push(k.beside(
    k.text(which, { wrap: false }),
    filter != null ? k.region('filter-all', { label: 'every record' }, k.text('{dim:·} {accent:show all}', { wrap: false })) : false,
    k.text(total ? `{dim:${n(rec + 1)} of ${n(total)}}` : ' ', { grow: 1, wrap: false, align: 'right' }),
    { gap: 1 },
  ))
  // how it was made, when Definition is open: under the conversation, above the actions
  const foot = st.def ? [k.region('side:opened', { label: 'how the label was made' }, k.stack(madeRows(k, lab, W)))] : []
  if (!total) { out.push(k.text('{dim:  no record has this value}'), ...foot); return k.stack(out) }
  if (!got) { out.push(k.text('{dim:  reading the records…}'), ...foot); return k.stack(out) }
  if (got.error) { out.push(k.text(`{bad:  × ${k.escape(got.error)}}`), ...foot); return k.stack(out) }
  const detail = cur ? recordDetail(k, lab, cur, W) : []
  const room = Math.max(3, k.h - out.length - detail.length - (st.def ? 8 : 0) - 2 - chromeOf(k, data.chat))
  const i0 = Math.max(0, recs.findIndex(r => r.i === rec))
  const top = Math.max(0, Math.min(recs.length - room, i0 - Math.floor(room / 2)))
  const placeW = Math.min(30, Math.max(8, ...recs.map(r => len(place(r.ref)))))
  const vW = Math.min(14, Math.max(8, ...values.map(len)))
  for (const r of recs.slice(top, top + room)) {
    const on = r.i === rec
    const v = r.value == null ? (r.waiting ? 'not yet' : 'no value') : r.value
    const tone = r.value == null ? (r.waiting ? 'unseen' : 'dim') : valueTone(values, r.value)
    const words = String(r.words || r.missing || '').replace(/\s+/g, ' ')
    const wroom = Math.max(10, W - 3 - placeW - 2 - (vW + 2) - 2 - 16 - 2)
    const line = `{dim:${k.escape(pad(place(r.ref), placeW))}}  {${tone}:● ${k.escape(pad(v, vW))}}  {dim:${k.escape(pad(byWords(r), 16))}}  ${on ? `**${k.escape(cut(words, wroom))}**` : k.escape(cut(words, wroom))}`
    out.push(k.region(`rec-${r.i}`, { label: `a record of ${lab.name}, ${place(r.ref)}: ${v} (${byWords(r) || 'no source'})`, ref: r.ref }, k.text(line, { wrap: false })))
  }
  out.push(k.text(' '))
  out.push(...detail)
  out.push(...foot)
  return k.stack(out)
}

/** How the label was made, when Definition is open: what made it, over which records, and its definition (the
 *  model's question, the pattern, the code) whole, up to a dozen rows. */
function madeRows(k, lab, W) {
  const def = String(lab.rule || '').replace(/\s+$/, '')
  const scope = [lab.in || 'the records Claude named', lab.where ? `where ${lab.where}` : '', lab.within ? `within ${lab.within[0]} = ${lab.within[1]}` : ''].filter(Boolean).join(' ')
  const out = [k.text(`{dim:made by} ${k.escape(madeBy(lab))}`, { wrap: false }), k.text(`{dim:over} ${k.escape(scope)}`, { wrap: false })]
  if (!def) return out
  const rows = lab.kind === 'code' ? def.split('\n') : wrap(def.replace(/\s+/g, ' '), W - 2)
  const tone = lab.kind === 'prompt' ? 'ink' : 'c1'
  out.push(...rows.slice(0, 12).map(r => k.text(`{dim:▎} {${tone}:${k.escape(cut(r, W - 2))}}`, { wrap: false })))
  if (rows.length > 12) out.push(k.text(`{dim:▎ … ${n(rows.length - 12)} more lines: thimble label ${k.escape(lab.name)}}`, { wrap: false }))
  return out
}

/** A record's ref as its place: the file's name and its line, `room.jsonl:44`. */
export function place(ref) {
  const [path, frag = ''] = String(ref).split('#')
  const name = path.slice(path.lastIndexOf('/') + 1)
  const m = /^L(\d+)/.exec(frag)
  return m ? `${name}:${m[1]}` : frag ? `${name}#${frag}` : name
}

/** Where a record's value comes from, in a word or two: `model 0.92`, `regex`, `you ✓`, `you (was no)`. */
export function byWords(r) {
  if (r.checked) return r.was != null && r.was !== r.value ? `you (was ${r.was})` : 'you ✓'
  if (r.waiting) return 'the model'
  if (r.by === 'model') return typeof r.confidence === 'number' ? `model ${r.confidence.toFixed(2)}` : 'model'
  return String(r.by || '')
}

/** The record selected, whole: its place, its value and where it came from, the model's reason, its words, and the
 *  values to check it with (each a press). */
function recordDetail(k, lab, r, W) {
  const tone = r.value == null ? 'dim' : valueTone(lab.values, r.value)
  const head = `{dim:${k.escape(r.ref)}} · {${tone}:● ${k.escape(r.value == null ? (r.waiting ? 'not labeled yet' : 'no value') : r.value)}} {dim:· ${k.escape(byLong(r))}}`
  const out = [k.text(head, { wrap: false })]
  if (r.reason) out.push(k.text(`{dim:why: ${k.escape(cut(String(r.reason).replace(/\s+/g, ' '), W - 6))}}`, { wrap: false }))
  if (r.error) out.push(k.text(`{bad:× ${k.escape(cut(r.error, W - 4))}}`, { wrap: false }))
  const text = String(r.text || r.words || r.missing || '').replace(/\r/g, '')
  for (const l of wrap(text.replace(/\n{2,}/g, '\n'), W - 2).slice(0, 5)) out.push(k.text(`  ${k.escape(l)}`, { wrap: false }))
  if (!r.missing) {
    // the person's check: the value they say it has (the one it has now reads as agreeing)
    const vs = (lab.values || []).slice(0, 9)
    out.push(k.beside(
      k.text('{dim:your check:}', { wrap: false }),
      ...vs.map((v, i) => k.region(`chk-${i}`, { label: `check: ${v}` }, k.text(`{${valueTone(lab.values, v)}:●} ${v === r.value ? `**${k.escape(v)}**` : k.escape(v)}`, { wrap: false }))),
      { gap: 2 },
    ))
  }
  return out
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
