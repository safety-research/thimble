// labels.js: the label viewer, a program on the card runtime (draw/kit.js) over the folder's labels (`thimble label
// --json`, engine/kernel/labels.py). It opens in the side panel (shell/side.ts openSide) as a thread: a question typed
// under it is about the label, value or record selected, and carries its refs. The bar's `2 labels` opens it (a click,
// or l). It brings back thimble 0.9's label views in the terminal: the labels list, each
// label with a bar of its values in their colors and a legend under it (0.9's home Labels block and labels list), and
// one label's panel: what made it (a rule or a model) and its definition, its values with their counts and bars, which
// filter its records, and its records with their values in color, stepped through and checked with the number keys,
// as the card detail checks a label's examples. The colors are the label card's (labels.py CARD_PROGRAM), so a value
// reads the same on the card and here.
//
//   state: {open: the label open, filter: the value its records are filtered to ('-': no value yet), rec: the record
//          selected (its place among the filtered ones), at: the part selected}
//   keys: the list: 1–9 a label · [ ] step (esc is the panel's: back, or close); a label: [ ] record · 1–9 check the
//         record (its values) · f filter · 0 back · esc back
//   wants: {records: name, value, at, n, gen} (a page of the records, read by the host)
//   asks of the host: check {label, ref, value} (the person's check), open {mark: {kind: 'cite', ref, label}} (↵ on
//         the record selected: its row as a citation, over this pane)

const PAGE = 20
// the rows the side panel takes under a pane: its input bar, and its thread's conversation when it has one (up to two
// fifths of the panel), so the records that fit show above them
const chromeOf = (k, chat) => 5 + (chat ? Math.floor(k.h * 0.4) : 0)
// the column the label panel's fields start at, after their names
const F = 11
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

/** What made a label, in plain words. */
export function madeBy(l) {
  const vs = l.values || []
  if (l.kind === 'prompt') return 'a model, reading each record against the definition'
  if (l.kind === 'regex') return `a rule: a record whose text matches the pattern is ${vs[0]}, the rest ${vs[vs.length - 1]}`
  if (l.kind === 'code') return 'a rule in code: label(unit) gives each record its value'
  if (l.kind === 'set') return 'Claude, giving values to records it read'
  return String(l.kind || 'unknown')
}

/** A label's parts as its bar and legend draw them: each value with records, then those still waiting for the model
 *  and those with no value. */
export function partsOf(l) {
  const counts = l.counts || {}
  const values = [...(l.values || []), ...Object.keys(counts).filter(v => !(l.values || []).includes(v))]
  const out = values.filter(v => counts[v] > 0).map(v => ({ name: v, n: counts[v], tone: valueTone(l.values, v), mark: '█' }))
  if (l.waiting) out.push({ name: 'waiting for the model', n: l.waiting, tone: 'unseen', mark: '░' })
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

export default {
  name: 'labels',
  title: 'Labels',
  local: ['at'],
  reads: () => ['labels'],
  stateKey: () => 'labels',
  /** What a question asked under the pane is about, beyond the part selected (side.ts paneSubject). */
  thread(_args, state, data) {
    const lab = state && state.open && data && Array.isArray(data.list) ? data.list.find(l => l.name === state.open) : null
    if (!lab) return { about: `the folder's labels (\`thimble label\`): ${((data && data.list) || []).map(l => l.name).join(', ') || 'none yet'}` }
    const counts = (lab.values || []).map(v => `${v} ${n((lab.counts || {})[v] || 0)}`).join(', ')
    return { about: `the label ${lab.name}, made by ${madeBy(lab)}, over ${lab.in || 'the records Claude named'}: ${n(lab.records || 0)} records (${counts}${lab.waiting ? `, ${n(lab.waiting)} waiting for the model` : ''})${lab.checked ? `; the analyst checked ${n(lab.checked)}` : ''}${state.filter ? `; its records filtered to ${state.filter === NO_VALUE ? 'those with no value yet' : state.filter}` : ''}. \`thimble label ${lab.name}\` shows it` }
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
  const lab = st.open ? data.list.find(l => l.name === st.open) || null : null
  if (!lab) return listView(k, data, st, W)
  return labelView(k, data, st, lab, W)
}

// ------------------------------------------------------------------------------------------------ the labels list

function listView(k, data, st, W) {
  const list = data.list
  const ids = list.map((_, i) => `lb-${i}`)
  const at = ids.includes(st.at) ? st.at : ids[0] || null
  const idx = ids.indexOf(at)
  const open = i => (list[i] ? { open: list[i].name, filter: null, rec: 0, at: 'rec-0' } : null)
  k.on('focus', e => (e.region && ids.includes(e.region) ? { at: e.region } : null))
  k.on('press', e => (e.region === at ? open(idx) : ids.includes(e.region) ? { at: e.region } : null))
  k.on('return', () => (idx >= 0 ? open(idx) : null))
  k.on('[', () => (ids.length ? { at: ids[Math.max(0, idx - 1)] } : null), 'step')
  k.on(']', () => (ids.length ? { at: ids[Math.min(ids.length - 1, idx + 1)] } : null), 'step')
  list.slice(0, 9).forEach((_, i) => k.on(String(i + 1), () => open(i), 'open a label'))
  if (at) k.select(at)
  const head = k.text(`**Labels**{dim: · ${n(list.length)} in this folder}${data.refreshing ? '{dim: · ◌}' : ''}`, { wrap: false })
  if (!list.length) return k.stack(head, k.text(' '), k.text('{dim:No labels here yet. Ask Claude to label records: it runs thimble label, and the label shows here.}'))
  const longest = Math.min(28, Math.max(...list.map(l => len(l.name))))
  const tw = Math.max(...list.map(l => n(l.records || 0).length))
  const bw = Math.max(8, Math.min(40, Math.round(W * 0.3)))
  const metaW = Math.max(0, W - 3 - longest - 2 - bw - 2 - tw - 2)
  const blocks = []
  list.forEach((l, i) => {
    const parts = partsOf(l)
    const on = i === idx
    const glyph = l.waiting && !(l.records - l.waiting) ? '{unseen:◌}' : `{${valueTone(l.values, (l.values || [])[0])}:●}`
    const name = k.escape(pad(l.name, longest))
    const meta = metaW > 6 ? `{dim:${k.escape(pad([l.kind, l.in, l.trial ? 'a trial sample' : ''].filter(Boolean).join(' · '), metaW))}}` : ''
    const bar = parts.length ? stacked(parts, bw) : `{dim:${pad('not run yet', bw)}}`
    const row = `${on ? '{accent:**▸**}' : ' '}${glyph} ${on ? `**${name}**` : name}  ${meta}  ${bar}  ${pad(n(l.records || 0), tw, true)}`
    blocks.push(k.region(`lb-${i}`, { label: `the label ${l.name}: ${n(l.records || 0)} records`, ...(l.query ? { ref: `${l.query}#${l.name}=${l.values[0]}@n` } : {}) }, k.text(row, { wrap: false })))
    blocks.push(k.text(`    ${parts.map(p => `{${p.tone}:${p.mark === '█' ? '●' : p.mark}} ${k.escape(p.name)} {dim:${n(p.n)}}`).join('   ')}`, { wrap: false }))
  })
  // two rows a label: as many as fit, from the one selected
  const room = Math.max(2, Math.floor((k.h - 3 - chromeOf(k, data.chat)) / 2))
  const top = Math.max(0, Math.min(list.length - room, idx - room + 2))
  const shown = blocks.slice(top * 2, (top + room) * 2)
  return k.stack(head, k.text(' '), ...shown, ...(list.length > top + room ? [k.text(`{dim:  ↓ ${n(list.length - top - room)} more}`)] : []))
}

// ------------------------------------------------------------------------------------------------ one label

function labelView(k, data, st, lab, W) {
  const values = lab.values || []
  const none = (lab.waiting || 0) + (lab.failed || 0)
  const filters = [null, ...values.filter(v => (lab.counts || {})[v] > 0), ...(none ? [NO_VALUE] : [])]
  const filter = filters.includes(st.filter) ? st.filter : null
  const total = filter == null ? lab.records || 0 : filter === NO_VALUE ? none : (lab.counts || {})[filter] || 0
  const rec = Math.max(0, Math.min(total - 1, Number(st.rec) || 0))
  const pageAt = Math.floor(rec / PAGE) * PAGE
  const got = total ? k.want({ records: lab.name, value: filter == null ? '*' : filter, at: pageAt, n: PAGE, gen: data.gen }) : null
  const recs = got && Array.isArray(got.records) ? got.records : []
  const cur = recs.find(r => r.i === rec) || null
  const valueIds = values.map((_, i) => `val-${i}`)
  const recIds = recs.map(r => `rec-${r.i}`)
  const fixed = ['back', 'filter-all', 'filter-none']
  const at = fixed.includes(st.at) || valueIds.includes(st.at) || recIds.includes(st.at) ? st.at : `rec-${rec}`

  // ---- what the person does
  const clamp = i => Math.max(0, Math.min(Math.max(0, total - 1), i))
  const toRec = i => ({ rec: clamp(i), at: `rec-${clamp(i)}` })
  const setFilter = v => ({ filter: v, rec: 0, at: v == null ? 'filter-all' : v === NO_VALUE ? 'filter-none' : `val-${values.indexOf(v)}` })
  const back = () => ({ open: null, filter: null, rec: 0, at: null })
  k.on('focus', e => {
    const m = /^rec-(\d+)$/.exec(String(e.region || ''))
    if (m) return { rec: Number(m[1]), at: e.region }
    return e.region ? { at: e.region } : null
  })
  k.on('press', e => {
    const r = String(e.region || '')
    if (r === 'back') return back()
    if (r === 'filter-all') return setFilter(null)
    if (r === 'filter-none') return setFilter(filter === NO_VALUE ? null : NO_VALUE)
    const v = /^val-(\d+)$/.exec(r)
    if (v) return setFilter(filter === values[Number(v[1])] ? null : values[Number(v[1])])
    const m = /^rec-(\d+)$/.exec(r)
    // a press on the record selected (↵ on it): its row as a citation, over this pane
    if (m && r === at && cur && Number(m[1]) === cur.i && !cur.missing) { k.do('open', { mark: { kind: 'cite', ref: cur.ref, label: `${lab.name} = ${cur.value ?? 'no value'}: ${place(cur.ref)}` } }); return null }
    if (m) return { rec: Number(m[1]), at: r }
    return null
  })
  k.on('[', () => toRec(rec - 1), 'record')
  k.on(']', () => toRec(rec + 1), 'record')
  // the record shown, checked by its value's number; then the next one (one that leaves the filter makes room for it)
  if (cur && !cur.missing) {
    values.slice(0, 9).forEach((v, i) => k.on(String(i + 1), () => {
      k.do('check', { label: lab.name, ref: cur.ref, value: v })
      return filter != null && filter !== v ? toRec(rec) : toRec(rec + 1)
    }, v))
  }
  if (filters.length > 1) k.on('f', () => setFilter(filters[(filters.indexOf(filter) + 1) % filters.length]), 'filter')
  k.on('0', back)
  k.on('esc', back, 'back')
  k.select(at)

  // ---- the header: the way back, the label's name, its version and size
  const out = []
  out.push(k.beside(
    k.region('back', { label: 'back to the labels' }, k.text('{accent:‹} {dim:labels ›}', { wrap: false })),
    k.text(`{${valueTone(values, values[0])}:●} **${k.escape(lab.name)}**`, { grow: 1, wrap: false }),
    k.text(`{dim:v${n(lab.version || 1)} · ${n(lab.records || 0)} records${lab.checked ? ` · ${n(lab.checked)} checked` : ''}}${data.refreshing ? '{dim: · ◌}' : ''}`, { wrap: false }),
    { gap: 1 },
  ))
  const field = (name, text) => k.text(`{dim:${pad(name, F)}}${text}`, { wrap: false })
  out.push(field('made by', `${k.escape(madeBy(lab))}${lab.waiting ? `{unseen: · ${n(lab.waiting)} wait for it}` : ''}`))
  const scope = [lab.in || 'the records Claude named', lab.where ? `where ${lab.where}` : '', lab.within ? `within ${lab.within[0]} = ${lab.within[1]}` : ''].filter(Boolean).join(' ')
  out.push(field('over', `${k.escape(scope)}${lab.trial ? `{dim: · a trial: ${n(lab.records || 0)} of ${n(lab.matched || 0)} at random}` : ''}`))
  // the definition whole (a few rows at most), as the label holds it: the model's question, the pattern, the code
  const def = String(lab.rule || '').replace(/\s+$/, '')
  const word = lab.kind === 'regex' ? 'pattern' : lab.kind === 'code' ? 'code' : 'definition'
  if (def) {
    const rows = lab.kind === 'code' ? def.split('\n') : wrap(def.replace(/\s+/g, ' '), W - F)
    const tone = lab.kind === 'prompt' ? 'ink' : 'c1'
    rows.slice(0, 4).forEach((r, i) => out.push(k.text(`{dim:${pad(i ? '' : word, F)}}{${tone}:${k.escape(cut(r, W - F))}}`, { wrap: false })))
    if (rows.length > 4) out.push(k.text(`{dim:${pad('', F)}… ${n(rows.length - 4)} more lines}`, { wrap: false }))
  }
  out.push(k.text(' '))

  // ---- the values: each its color, bar, count and share; a press filters the records to it
  const counts = lab.counts || {}
  const vw = Math.min(24, Math.max(4, ...values.map(len), none ? 12 : 0))
  const bw = Math.max(6, Math.min(30, W - 10 - 2 - vw - 2 - 26))
  const max = Math.max(1, ...values.map(v => counts[v] || 0), none)
  const valueRow = (id, label, tone, mark, c, on, sel) => {
    const cells = c ? Math.max(1, Math.round((c / max) * bw)) : 0
    const row = `{dim:${pad(id === 'val-0' ? 'values' : '', F - 2)}}${sel ? '{accent:**▸**}' : ' '} {${tone}:${mark}} ${on ? `{accent:**${k.escape(pad(label, vw))}**}` : k.escape(pad(label, vw))}  {${tone}:${'█'.repeat(cells)}}${' '.repeat(bw - cells)}  ${pad(n(c), 7, true)} {dim:${pad(lab.records ? pctOf(c / lab.records) : '', 4, true)}}${on ? '  {accent:filter on}' : ''}`
    const value = id.startsWith('val-') ? values[Number(id.slice(4))] : null
    // a value carries the citation of its count (the label's count query), so a question about it names its records
    const ref = value != null && lab.query && /^[\w.-]+$/.test(lab.name) && /^[\w.-]+$/.test(value) ? `${lab.query}#${lab.name}=${value}@n` : null
    return k.region(id, { label: `${lab.name} = ${label}: ${n(c)} records${on ? ', the filter' : ''}`, ...(ref ? { ref } : {}) }, k.text(row, { wrap: false }))
  }
  values.forEach((v, i) => out.push(valueRow(`val-${i}`, v, valueTone(values, v), '●', counts[v] || 0, filter === v, at === `val-${i}`)))
  if (none) out.push(valueRow('filter-none', 'no value yet', 'unseen', '░', none, filter === NO_VALUE, at === 'filter-none'))
  const agree = lab.checked ? `${n(lab.checked)} checked: ${n(lab.agree || 0)} agree, ${n(lab.disagree || 0)} changed` : 'none checked yet'
  out.push(field('checks', agree))
  out.push(k.text(' '))

  // ---- the records: the filter, the list around the one selected, and that one whole
  out.push(k.beside(
    k.region('filter-all', { label: 'every record' }, k.text(`{dim:${pad('records', F)}}${filter == null ? `**all ${n(total)}**` : `all ${n(lab.records || 0)}`}`, { wrap: false })),
    k.text(filter == null ? ' ' : `{dim:·} filter: {${valueTone(values, filter)}:**${k.escape(filter === NO_VALUE ? 'no value yet' : filter)}**} {dim:(${n(total)})}`, { grow: 1, wrap: false }),
    k.text(total ? `{dim:${n(rec + 1)} of ${n(total)}}` : ' ', { wrap: false }),
    { gap: 2 },
  ))
  if (!total) { out.push(k.text('{dim:  no record has this value}')); return k.stack(out) }
  if (!got) { out.push(k.text('{dim:  reading the records…}')); return k.stack(out) }
  if (got.error) { out.push(k.text(`{bad:  × ${k.escape(got.error)}}`)); return k.stack(out) }
  const detail = cur ? recordDetail(k, lab, cur, W) : []
  const room = Math.max(3, k.h - out.length - detail.length - 1 - chromeOf(k, data.chat))
  const i0 = Math.max(0, recs.findIndex(r => r.i === rec))
  const top = Math.max(0, Math.min(recs.length - room, i0 - Math.floor(room / 2)))
  const placeW = Math.min(30, Math.max(8, ...recs.map(r => len(place(r.ref)))))
  const vW = Math.min(14, Math.max(8, ...values.map(len)))
  for (const r of recs.slice(top, top + room)) {
    const on = r.i === rec
    const v = r.value == null ? (r.waiting ? 'waiting' : 'no value') : r.value
    const tone = r.value == null ? (r.waiting ? 'unseen' : 'dim') : valueTone(values, r.value)
    const words = String(r.words || r.missing || '').replace(/\s+/g, ' ')
    const wroom = Math.max(10, W - 3 - placeW - 2 - (vW + 2) - 2 - 16 - 2)
    const line = `${on ? '{accent:**▸**}' : ' '} {dim:${k.escape(pad(place(r.ref), placeW))}}  {${tone}:● ${k.escape(pad(v, vW))}}  {dim:${k.escape(pad(byWords(r), 16))}}  ${on ? `**${k.escape(cut(words, wroom))}**` : k.escape(cut(words, wroom))}`
    out.push(k.region(`rec-${r.i}`, { label: `a record of ${lab.name}, ${place(r.ref)}: ${v} (${byWords(r) || 'no source'})`, ref: r.ref }, k.text(line, { wrap: false })))
  }
  out.push(k.text(' '))
  out.push(...detail)
  return k.stack(out)
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

/** The record selected, whole: its place, its value and where it came from, the model's reason, and its words. */
function recordDetail(k, lab, r, W) {
  const tone = r.value == null ? 'dim' : valueTone(lab.values, r.value)
  const head = `{dim:${k.escape(r.ref)}} · {${tone}:● ${k.escape(r.value == null ? (r.waiting ? 'waiting for the model' : 'no value') : r.value)}} {dim:· ${k.escape(byLong(r))}}`
  const out = [k.text(head, { wrap: false })]
  if (r.reason) out.push(k.text(`{dim:why: ${k.escape(cut(String(r.reason).replace(/\s+/g, ' '), W - 6))}}`, { wrap: false }))
  if (r.error) out.push(k.text(`{bad:× ${k.escape(cut(r.error, W - 4))}}`, { wrap: false }))
  const text = String(r.text || r.words || r.missing || '').replace(/\r/g, '')
  for (const l of wrap(text.replace(/\n{2,}/g, '\n'), W - 2).slice(0, 5)) out.push(k.text(`  ${k.escape(l)}`, { wrap: false }))
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
