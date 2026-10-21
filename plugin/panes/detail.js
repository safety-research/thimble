// detail.js: the card detail, a program on the card runtime (draw/kit.js) over the card Claude saved: its object, its
// versions and its drawing (run by the host in the card's own sandbox, at the detail's width, with the card's state).
// "Overview first, zoom and filter, details on demand": the card's subject at the top as every thread's (subject.js:
// its title, "edited" when the analyst asked for a change, the labels its data came through), the takeaway with its
// citations, the card enlarged with its parts, and on demand the selected part's rows: its claim and the records
// behind it. The card's thread is the host's: in the terminal the side panel draws it under this page with its input
// bar (shell/side.ts).
//
//   state: {region: the selected part, bar: null | 'examples' (the selected part's rows; 'details' reads the same), ex:
//          the first record shown, prog: the program, pages: 'all' | 'one' (a card with pages)}
//   presses: a part selects it, the selected part shows its rows (again: hides them), a version shows it, a knob's
//          ◂ ▸ turns it, a record of the rows opens it as a citation, a label opens it in the panel
//   actions (above the input bar, `act:<id>`): Records, Rows or Lines (the selected part's entries, in their files' own
//          word; none when they are whole files) · Code (the program, its lines that
//          drew the part lit) · Earlier version (the card before the analyst's last change; from the first, the newest). What one opens is the `side:opened` region, which the side panel draws right above the
//          actions, under the thread's conversation; the card stays at the top. keys: none of its own beside esc (the
//          code, then the rows, then the panel goes back); the ring walks the parts (↑ ↓, tab) and ↵ presses the one
//          it is on
//
// Pages: a card with a page knob (kit.js) is shown with every page at once, one after another, each under its own
// heading, when PAGES_DEFAULT says so (carddetail.js); the host draws it so (shell/detail.tsx). Its parts are then its
// pages' (`pg3~~x`, handoff.js), the headings among them.
//   events: focus (the ring on a part), press, act:rows, act:code, esc
//   asks of the host: card {state} (a knob of the card turned), version {v}, close, open {mark} (a record as a citation),
//         label {name, value} (a label it rests on, in the panel)
//   wants: {rows: refs} (the rows behind the selected part), {labels: refs, gen} (the labels of the records shown)
//
// Labels: each record shows the values labels gave it (`thimble label`), and the rows say how the part's records split
// by each label. A label's own panel checks records (panes/labels.js).
//
// The card's own keys and presses (its program's k.on) come before these: the host routes them to the card first.
import { examplesView, exampleSet, linkRuns, partOfLink, programLines, stepVersion } from '../shell/carddetail.js'
import { entryWords, healLook } from '../shell/cards.js'
import { toneBeside } from './labels.js'
import { subjectBlock } from './subject.js'
import { pageId, pageOf, turn as turnKnob } from '../draw/handoff.js'
import { chainWords, regionRefs } from '../shell/object.js'
import { renderTerm } from '../draw/term.js'

const EXR = 9
const n = x => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))
const cut = (s, k) => (Array.from(String(s)).length <= k ? String(s) : Array.from(String(s)).slice(0, Math.max(0, k - 1)).join('') + '…')

export default {
  name: 'detail',
  title: 'Card',
  // the card itself, from the host: its object, versions and drawing (run in the card's own sandbox)
  reads: args => [`card:${args.id}`],
  stateKey: args => `detail-${String(args.id || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 96)}`,
  data(stores, args, size) {
    const card = stores[`card:${args.id}`]
    if (!card || !card.object) return { id: args.id, loading: 'no card' }
    const o = card.object
    const d = card.drawing
    if (!d) return { id: o.id, title: o.title || o.id, loading: 'drawing' }
    if (d.error) return { id: o.id, title: o.title || o.id, error: `${d.error.name}: ${d.error.message || ''}`.slice(0, 200), fix: d.error.fix || '' }
    // the card without its own frame: the header here has its title, the from line its sources
    const r = d.root
    const framed = r && r.t === 'frame' && r.kid && r.tone !== 'bad'
    const inner = framed ? { ...d, root: r.kid } : d
    const parts = []
    for (const g of d.regions || []) {
      if (!g || !g.id || parts.some(p => p.id === g.id)) continue
      const m = g.meta || {}
      parts.push({ id: g.id, label: String(m.label || g.id), ...(m.knob ? { knob: m.knob } : {}), cite: typeof m.cite === 'string' ? m.cite : null, examples: typeof m.examples === 'string' ? m.examples : null, fields: m.fields || null })
    }
    // a link in the card's words to a cite, an examples set or a knob that no part draws is a part too, so a click on it
    // does what selecting it does: the cite's rows, the examples, or the knob turned
    for (const id of linkTargets(inner.root)) {
      if (parts.some(p => p.id === id || p.cite === id || p.examples === id)) continue
      const c = d.cites && d.cites[id], e = d.examples && d.examples[id], knob = (d.controls || []).find(x => x.id === id)
      if (c) parts.push({ id, label: String(c.text || id), cite: id, examples: null, fields: null, link: true })
      else if (e) parts.push({ id, label: String(e.label || id), cite: null, examples: id, fields: null, link: true })
      else if (knob) parts.push({ id, label: String(knob.label || id), knob: id, cite: null, examples: null, fields: null, link: true })
    }
    const refs = {}
    for (const p of parts) refs[p.id] = regionRefs(o, d, p.id).refs
    // the parts in reading order, as drawn at this width: the order ↑ ↓ and tab walk them in, links among them
    let order = null
    try {
      const grid = renderTerm(inner, { w: Math.max(20, size.w || 96) })
      const at = new Map()
      for (const g of grid.regions || []) for (const q of g.rects || []) { const was = at.get(g.id); if (!was || q.y < was.y || (q.y === was.y && q.x < was.x)) at.set(g.id, q) }
      order = parts.map(p => p.id).filter(id => at.has(id)).sort((a, b) => at.get(a).y - at.get(b).y || at.get(a).x - at.get(b).x)
    } catch { order = null }
    return {
      id: o.id, title: o.title || o.id, question: o.question || '', text: o.text || '', program: o.program || '', version: o.version ?? null,
      // what the healing pass did to the takeaway's citations (the host's: shell.tsx healOfText)
      heal: card.heal || null,
      versions: card.versions || [], v: card.v ?? o.version ?? null, drawing: inner, parts, refs, order,
      cites: d.cites || {}, examples: d.examples || {}, controls: d.controls || [], cardState: card.state || {},
      // the card shown with every page at once ({knob, n, at}), and the keys its own program takes (with what they turn)
      pages: d.pages || null, cardOn: d.on || [],
      w: size.w, h: size.h,
      // a label's card names its label; the host counts the checks made since it opened, so their labels are read again
      label: typeof o.label === 'string' ? o.label : null, labelGen: card.labelGen || 0,
      // the labels its data came through (the host reads them: `thimble label --used-by`)
      labels: Array.isArray(card.labels) ? card.labels : [],
    }
  },
  program,
}

export function program(k, data) {
  if (data.loading) return k.text(data.loading === 'drawing' ? `{dim:drawing ${k.escape(data.id || 'the card')}…}` : `{dim:No card is open. A card Claude saves shows under its reply; open it from there.}`)
  if (data.error) return k.text(`{bad:×} **${k.escape(data.title)}** {dim:could not be drawn:} ${k.escape(data.error)}${data.fix ? ` {dim:· fix:} ${k.escape(data.fix)}` : ''}`)
  const st = k.state || {}
  const parts = data.parts || []
  const ids = parts.map(p => p.id)
  const all = data.pages
  // the part selected: the one the state names; a part of a page (`pg3~~x`) while the card shows one page is `x`, and a
  // card's own part (`x`, named from outside) while it shows every page is `x` on the page the card is at, else on the
  // first page that has it. At rest: the heading of the page the card is at, else the first part
  const resolve = r => {
    if (r == null) return null
    if (ids.includes(r)) return r
    const pg = pageOf(r)
    if (pg && !all) return ids.includes(pg.id) ? pg.id : null
    if (!pg && all) return ids.includes(pageId(all.at, r)) ? pageId(all.at, r) : ids.find(x => pageOf(x)?.id === r) ?? null
    return null
  }
  const region = resolve(st.region) ?? (all && ids.includes(pageId(all.at, '')) ? pageId(all.at, '') : ids[0] ?? null)
  const part = parts.find(p => p.id === region) || null
  const bar = st.bar || null
  const prog = !!st.prog
  const ex = st.ex || 0

  // ---- what the person does: each a new state, or an action of the host
  const pick = id => (ids.includes(id) ? { region: id, ex: 0 } : null)
  // the keys walk the parts in reading order, the links to a cite, examples or a knob among them
  const walk = Array.isArray(data.order) && data.order.length ? data.order.filter(id => ids.includes(id)) : ids
  const step = dir => () => {
    if (!walk.length) return null
    const i = walk.indexOf(region)
    return pick(walk[i < 0 ? 0 : (i + dir + walk.length) % walk.length])
  }
  k.on('up', step(-1))
  k.on('down', step(1))
  k.on('tab', step(1))
  k.on('shift+tab', step(-1))
  // the terminal's ring on a part, the browser's click on one
  k.on('focus', e => (e.region && ids.includes(e.region) ? pick(e.region) : null))
  const control = id => (data.controls || []).find(c => c.id === id) || null
  const turnCard = (id, dir) => {
    if (!control(id)) return null
    k.do('card', { state: turnKnob({ controls: data.controls }, data.cardState, id, dir), knob: id })
    return { region: id }
  }
  k.on('press', e => {
    const r = e.region
    const ver = /^ver-(\d+)$/.exec(String(r || ''))
    if (ver) { k.do('version', { v: Number(ver[1]) }); return { ex: 0 } }
    // a record of the rows: opened as a citation, over the card; the next records
    const exm = /^side:rows:(\d+)$/.exec(String(r || ''))
    if (exm) { const rec = exampleRecords(k, data, part).records[Number(exm[1])]; if (rec && rec.ref) k.do('open', { mark: { kind: 'cite', ref: rec.ref, label: String(rec.words || rec.ref).slice(0, 60) } }); return null }
    if (r === 'side:rows:more') return { ex: ex + EXR - 1 }
    // a label the card rests on, in the panel (a value: its records)
    const lab = /^side:label:(\d+)(?::(\d+))?$/.exec(String(r || ''))
    if (lab) { const l = (data.labels || [])[Number(lab[1])]; if (l) k.do('label', { name: l.name, value: lab[2] != null ? l.values[Number(lab[2])] ?? null : null }); return null }
    // a link to a knob (its dial, or words that point at it): the knob turns, a step back on its left half, on on its right
    const linked = parts.find(p => p.id === r && p.link)
    if (linked && linked.knob) return turnCard(linked.knob, e.dir || 1)
    // a link to a cite or to examples opens what it points at: the cite's rows, the examples
    if (linked && r !== region) return { region: r, ex: 0, bar: 'examples' }
    if (!r || !ids.includes(r)) return null
    if (e.dir) return turnCard(r, e.dir)
    // a press on the selected part shows its rows (and hides them again)
    if (r === region) return { bar: bar ? null : 'examples', ex: 0 }
    return pick(r)
  })
  // the actions above the input bar, in words: the selected part's entries in their files' own word (Records, Rows,
  // Lines), and the card's code (the open one `:on`). A part whose records are whole files has no entries to show.
  const words = partWords(k, data, part)
  if (words) k.on(bar && !prog ? 'act:rows:on' : 'act:rows', () => ({ bar: bar && !prog ? null : 'examples', ex: 0, prog: false }), words.many.replace(/^./, c => c.toUpperCase()))
  k.on(prog ? 'act:code:on' : 'act:code', () => ({ prog: !prog }), 'Code')
  // the card as first made and after each change the analyst asked for (carddetail.js editsOf): a step back through
  // them, and from the first to the card now
  const versions = data.versions || []
  const vat = versions.findIndex(x => x.v === data.v)
  if (versions.length > 1) k.on('act:version', () => { k.do('version', { v: stepVersion(versions, data.v) }); return { ex: 0 } }, vat === 0 ? 'Newest version' : 'Earlier version')
  // esc closes what was opened last (the program over the card, else the rows under it), then the detail
  k.on('esc', () => {
    if (prog) return { prog: false }
    if (bar) return { bar: null }
    k.do('close')
    return null
  }, 'back')

  if (region) k.select(region)

  // ---- the subject: the title, "edited" (no version numbers) or which version shows, and the labels its data came
  // through
  const W = Math.max(30, k.w)
  const latestV = versions.length ? versions[versions.length - 1].v : null
  const older = versions.length > 1 && data.v != null && latestV != null && data.v < latestV
  const where = !versions.length ? '' : !older ? 'edited' : vat === 0 ? '{accent:as first made}' : vat > 0 ? `{accent:after change ${versions[vat].n}}` : '{accent:an earlier version}'
  // each label its data came through, on a row of its own: its name and its values in their colors, each a press
  const labelRows = (data.labels || []).slice(0, 3).map((l, i) => [
    k.text('{dim:label }', { wrap: false }),
    k.region(`side:label:${i}`, { label: `the label ${l.name}` }, k.text(`**${k.escape(l.name)}**`, { wrap: false })),
    ...(l.values || []).slice(0, 6).flatMap((v, j) => [k.text('  ', { wrap: false }), k.region(`side:label:${i}:${j}`, { label: `the records of ${l.name} that are ${v}` }, k.text(`{${toneBeside(l, v)}:● ${k.escape(v)}}`, { wrap: false }))]),
  ])
  const head = subjectBlock(k, {
    title: k.escape(cut(data.title, W - 4)),
    // (a card says what it is only beside its version: a line of the one word `card` says nothing the panel does not)
    line: where ? `card · ${where}` : '',
    rows: labelRows,
  })
  // the takeaway: its citations of a part select that part (and the selected part's are bold)
  const take0 = String(data.text || data.question || '').replace(/\s+/g, ' ').trim()
  // a takeaway that says the title again (a label's card: `kind: 4,174 of … records are …` over `4,174 of … records
  // are ….`) is left out
  const take = sameWords(take0, data.title) ? '' : take0
  const refsOf = id => data.refs[id] || []
  // the healing pass: a citation it unwrapped in grey, one it found contradicted with a red ×, one it re-pointed at its
  // new place
  const look = healLook(data.heal)
  const takeaway = take ? k.text(linkRuns(take).map(r => {
    const s = k.escape(r.s)
    if (!r.link) return r.bold ? `**${s}**` : s
    const c = look ? look(r.s, r.link) : null
    if (c && c.state === 'quiet') return `{dim:${s}}${c.how === 'gone' ? '{dim: ?}' : ''}`
    const bad = c && c.state === 'contradicted' ? '{bad: ×}' : ''
    const to = partOfLink(c && c.to && c.state === 'linked' ? c.to : r.link, parts, refsOf)
    return (to ? (to === region ? `**{cite:[${s}](#${to})}**` : `{cite:[${s}](#${to})}`) : `{cite:${s}}`) + bad
  }).join('')) : false

  // what an action opened: the code, else the selected part's rows, in the `side:opened` region the panel draws above the
  // input bar
  const below = prog ? programView(k, data, part, W) : bar ? barView(k, data, part, bar, ex, W) : null
  return k.stack(head, takeaway, k.text(' '), k.embed(data.drawing), below ? k.region('side:opened', { label: prog ? 'the code' : `the ${(words || ROWS).many}` }, below) : false)
}

/** The ids the links in a drawing's words point at (`[words](#id)`), each once, in the order drawn. */
export function linkTargets(root) {
  const out = []
  const runs = rs => { if (Array.isArray(rs)) for (const r of rs) if (r && r.ref && !out.includes(r.ref)) out.push(r.ref) }
  const walk = x => {
    if (!x || typeof x !== 'object') return
    if (x.t === 'text') runs(x.runs)
    if (x.t === 'frame') { runs(x.title); runs(x.right); runs(x.bottom) }
    if (x.t === 'table') (x.rows || []).forEach(r => (r.cells || []).forEach(runs))
    if (x.t === 'canvas') (x.ops || []).forEach(op => { if (op[0] === 'text') runs(op[3]); else if (op[0] === 'box') runs(op[6]) })
    ;(x.kids || []).forEach(walk)
    if (x.kid) walk(x.kid)
  }
  walk(root)
  return out
}


const ROWS = { many: 'rows', one: 'row' }

/** What the selected part's entries are called, in their files' own word (cards.js entryWords: the `unit` thimble
 *  resolve gives, from the one mapping coverage counts by): records of JSON and JSONL, rows of a table, lines of text.
 *  null when the rows behind the part are whole files (an image, a PDF, a file cited whole) and the program attached
 *  no records; `rows` while the answer is not in hand. It asks for what the rows under the card ask for. */
export function partWords(k, data, part) {
  const refs = part ? data.refs[part.id] || [] : []
  const resolved = refs.length ? k.want({ rows: refs, n: 8 }) : null
  // (while the rows are being read their unit is not known: no word yet, rather than `Rows` that turns into `Records`)
  if (refs.length && !resolved) return null
  if (!resolved || resolved.error) return ROWS
  const w = entryWords(resolved)
  if (w && !(resolved.count == null && (resolved.rows || []).length)) return w
  return exampleSet({ examples: data.examples }, { examples: part.examples }) ? w || ROWS : null
}

/** Whether `text` says nothing more than `title`: its words (a link's words, without its target) are the title's, or its
 *  end. */
export function sameWords(text, title) {
  const words = s => String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const a = words(text), b = words(title)
  return !!a && !!b && (b === a || b.endsWith(` ${a}`))
}

/** The records the examples bar shows for a part: those the program attached, else the rows behind the part. */
function exampleRecords(k, data, part) {
  const set = exampleSet({ examples: data.examples }, { examples: part.examples })
  if (set) return { set, records: set.records, resolved: null }
  const refs = data.refs[part.id] || []
  const resolved = refs.length ? k.want({ rows: refs, n: 8 }) : null
  const chain = resolved ? chainWords(resolved) : null
  return { set: null, records: chain && !chain.error ? chain.records : [], resolved, chain }
}

/** The labels of records, as the host read them: {ref: {label: {value, by, confidence, reason, checked, was}}}. */
function labelsOf(k, data, records) {
  const refs = (records || []).map(r => r && typeof r === 'object' ? r.ref : null).filter(r => typeof r === 'string')
  if (!refs.length) return {}
  const got = k.want({ labels: refs.slice(0, 200), gen: data.labelGen || 0 })
  return got && !got.error ? got : {}
}



/** A record's labels in a few words: `apology yes · model 0.92`, `apology no → you: yes`, `apology yes ✓ you`. */
export function labelWords(labels) {
  return Object.entries(labels || {}).map(([name, e]) => {
    if (e.waiting) return `${name}: waiting for the model`
    if (e.value == null) return `${name}: no value${e.error ? ` (${e.error})` : ''}`
    if (e.checked) return e.was != null && e.was !== e.value ? `${name}: ${e.was} → you: ${e.value}` : `${name}: ${e.value} ✓ you`
    const how = e.by === 'model' && typeof e.confidence === 'number' ? `model ${e.confidence.toFixed(2)}` : e.by || ''
    return `${name}: ${e.value}${how ? ` · ${how}` : ''}${e.reason ? `: ${e.reason}` : ''}`
  }).join('  ·  ')
}

/** How a part's rows split by each label that holds some of them: `apology: 12 yes · 30 no`. */
export function splitWords(labels) {
  return Object.entries(labels || {}).map(([name, b]) => {
    const parts = Object.entries(b.values || {}).map(([v, c]) => `${n(c)} ${v}`)
    if (b.none) parts.push(`${n(b.none)} no value`)
    return `${name}: ${parts.join(' · ')}${b.rows > b.of ? ` (${n(b.of)} of ${n(b.rows)} rows labeled)` : ''}`
  })
}

/** The bar under the card: empty until asked, then the selected part's rows: its claim, where it comes from, how its
 *  rows split by the labels that hold them, and the records behind it (each a press that opens it as a citation), a
 *  few at a time with a press for the next ones. */
function barView(k, data, part, bar, ex, W) {
  const out = []
  if (!bar || !part) return k.text('{dim:Select a part of the card to see its rows.}')
  const cite = part.cite ? data.cites[part.cite] : null
  const set = exampleSet({ examples: data.examples }, { examples: part.examples })
  const refs = data.refs[part.id] || []
  const resolved = refs.length ? k.want({ rows: refs, n: 8 }) : null
  const chain = resolved ? chainWords(resolved) : null
  const records = set ? set.records : chain && !chain.error ? chain.records : []
  const total = set ? (set.total ?? set.records.length) : resolved?.count ?? records.length
  // the part's claim, and the filter the card has on; where its values come from is one press away (Code)
  const claim = String(cite?.text || part.label || part.id).replace(/\*\*/g, '')
  const filter = (data.controls || []).find(c => c.id === 'filter')
  out.push(k.text(`**${k.escape(cut(claim, W))}**` + (filter && filter.i > 0 ? `{dim: · }{accent:filter on: ${k.escape(String(filter.shown[filter.i]))}}` : ''), { wrap: false }))
  // the labels that hold the part's rows, and how the rows split by each
  const split = resolved && !resolved.error ? splitWords(resolved.labels) : []
  if (split.length) out.push(k.text(`{accent:label} ${split.map(x => k.escape(cut(x, W - 8))).join('{dim:  ·  }')}`, { wrap: false }))
  // its records (the examples the program attached, else the rows behind it), a few at a time; a part with none shows
  // nothing more
  const of = String(set?.label || claim)
  const nrec = records.length
  const at = nrec ? (((ex % nrec) + nrec) % nrec) : 0
  out.push(k.text(' '))
  const labels = labelsOf(k, data, records)
  const body = []
  if (!nrec) {
    if (refs.length && !resolved) body.push(k.text('{dim:   reading its records…}'))
    else if (chain && chain.error) body.push(k.text(`{bad:   ${k.escape(chain.notes[0] || 'its rows could not be read')}}`))
  } else {
    const view = examplesView(records, { at, fit: EXR - 1, fmt: set?.fmt, fields: part.fields ?? set?.fields })
    const first = view.rows[0]?.i ?? 0
    const last = view.rows[view.rows.length - 1]?.i ?? 0
    out.push(k.beside(
      k.text(`{dim:${n(first + 1)}–${n(last + 1)} of ${n(total)}}`, { wrap: false }),
      nrec > view.rows.length ? k.region('side:rows:more', { label: 'the next records' }, k.text('{accent:next ›}', { wrap: false })) : false,
      { gap: 2 },
    ))
    if (view.kind === 'table') {
      const cols = view.cols
      const val = (r, key) => (r?.[key] == null ? '' : typeof r[key] === 'number' && !/(^|_)(id|step|epoch|run|rev|line|seq)$/i.test(key) ? n(r[key]) : String(r[key]))
      const widths = cols.map((key, i) => (i === cols.length - 1 ? 0 : Math.min(18, Math.max(key.length, ...view.rows.map(x => val(x.rec, key).length)))))
      const line = cells => cells.map((v, i) => (i === cells.length - 1 ? v : (v + ' '.repeat(widths[i] ?? 0)).slice(0, widths[i] ?? 0) + '  ')).join('')
      body.push(k.text(`{dim:  ${k.escape(line(cols))}}`, { wrap: false }))
      for (const r of view.rows) body.push(k.region(`side:rows:${r.i}`, { label: `record ${r.i + 1} behind ${of}` }, k.text(`  ${k.escape(cut(line(cols.map(key => val(r.rec, key))), W - 4))}`, { wrap: false })))
    } else {
      for (const r of view.rows) {
        const ref = records[r.i] && typeof records[r.i] === 'object' ? records[r.i].ref : null
        const tags = ref ? labelWords(labels[ref]) : ''
        body.push(k.region(`side:rows:${r.i}`, { label: `record ${r.i + 1} behind ${of}`, ...(ref ? { ref } : {}) }, k.stack(
          k.text(`  ${k.escape(cut(r.words || '', W - 4))}`, { wrap: false }),
          tags
            ? k.text(`    {accent:${k.escape(cut(tags, W - 8))}}${r.meta ? `{dim:  ·  ${k.escape(cut(r.meta, Math.max(0, W - 12 - tags.length)))}}` : ''}`, { wrap: false })
            : k.text(`{dim:    ${k.escape(cut(r.meta || '', W - 6))}}`, { wrap: false }),
        )))
      }
    }
  }
  return k.stack(out, body)
}

/** p: how Claude drew this. The program's lines, the ones that drew the selected part lit, and the rows behind it. */
function programView(k, data, part, W) {
  const lines = String(data.program || '').split('\n')
  const lit = programLines(data.program, part?.id)
  const out = []
  out.push(k.beside(
    k.text(`{warn:✻} **how Claude drew this**{dim: · ${lines.length} lines of the card program}`, { grow: 1, wrap: false }),
    k.text(`{accent:▌}{dim: lines that drew }{accent:**${k.escape(cut(String(part?.label || 'the card'), 30))}**}`, { wrap: false }),
    { gap: 2 },
  ))
  const refs = part ? data.refs[part.id] || [] : []
  if (refs[0]) out.push(k.text(`{dim:rows  ${k.escape(refs[0])}}`, { wrap: false }))
  out.push(k.text(' '))
  const first = Math.min(...[...lit], lines.length) || 1
  // (the rows the panel gives what an action opened: about two fifths of it)
  const h = Math.max(6, Math.floor((data.h || 30) * 0.4))
  const top = Math.max(0, Math.min(first - 4, lines.length - h))
  for (let i = top; i < Math.min(lines.length, top + h); i++) {
    const hit = lit.has(i + 1)
    const num = String(i + 1).padStart(3)
    out.push(k.text(hit ? `{accent:**${num} ▌**} ${k.escape(cut(lines[i] || ' ', W - 8))}` : `{dim:${num} │} ${k.escape(cut(lines[i] || ' ', W - 8))}`, { wrap: false, raw: false }))
  }
  return k.stack(out)
}
