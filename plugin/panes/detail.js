// detail.js: the card detail, a program on the card runtime (draw/kit.js) over the card Claude saved: its object, its
// versions and its drawing (run by the host in the card's own sandbox, at the detail's width, with the card's state).
// "Overview first, zoom and filter, details on demand": a header (the title, the card's id, v1 · v2), the takeaway with
// its citations, the card enlarged with its parts, and a bar under it that starts empty and fills on demand with the
// selected part's details (its claim and where it comes from) and its examples, labelled with what they are examples
// of. The program the card is behind p. The card's thread is the host's: in the terminal the side panel draws it under
// this page with its input bar (shell/side.ts), and its keys (t threads, m send to main) are the panel's; the browser's
// chat.
//
//   state: {region: the selected part, bar: null | 'details' | 'examples', ex: the example shown, prog: the program,
//          pages: 'all' | 'one' (a card with pages: every page at once, or one at a time)}
//   keys: ↑↓ part · ↵ details · e examples · [ ] flip · + − zoom · f filter · , . turn · a all at once / one at a time ·
//         p program · h versions · 0 clear · esc back
//
// Pages: a card with a page knob (kit.js) is shown with every page at once, one after another, each under its own
// heading, when the person chose so (a) or PAGES_DEFAULT says (carddetail.js); the host draws it so (shell/detail.tsx).
// Its parts are then its pages' (`pg3~~x`, handoff.js), the headings among them; , and . go a page back or on.
//   events: focus (the ring on a part), press (a part; the selected one opens its details; a version; a knob's ◂ ▸)
//   asks of the host: card {state} (a knob of the card turned), version {v}, close,
//         check {label, ref, value} (the person's check of a record's label value)
//   wants: {rows: refs} (the rows behind the selected part), {facts: id} (where the card's values come from),
//          {labels: refs, gen} (the labels of the examples shown, read again after each check)
//
// Labels: each example shows the values labels gave it (`thimble label`), and the details say how the part's rows
// split by each label. On a record a label holds, the number keys check it: 1 for the label's first value, 2 for its
// second, and so on (the label of a label's card, else the record's first). The check is the person's: it is recorded
// beside the value the label gave, counts in its place, and the examples step on to the next record.
//
// The card's own keys and presses (its program's k.on) come before these: the host routes them to the card first.
import { barAfter, cycleKnob, examplesView, exampleSet, fromLine, linkRuns, namedKnob, partOfLink, programLines, shownVersions, stepVersion } from '../shell/carddetail.js'
import { pageId, pageOf, turn as turnKnob } from '../draw/handoff.js'
import { chainWords, regionRefs } from '../shell/object.js'

const EXR = 6
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
    return {
      id: o.id, title: o.title || o.id, question: o.question || '', text: o.text || '', program: o.program || '', version: o.version ?? null,
      versions: card.versions || [], v: card.v ?? o.version ?? null, drawing: inner, parts, refs,
      cites: d.cites || {}, examples: d.examples || {}, controls: d.controls || [], cardState: card.state || {},
      // the card shown with every page at once ({knob, n, at}), and the keys its own program takes (with what they turn)
      pages: d.pages || null, cardOn: d.on || [],
      w: size.w, h: size.h,
      // a label's card names its label; the host counts the checks made since it opened, so their labels are read again
      label: typeof o.label === 'string' ? o.label : null, labelGen: card.labelGen || 0,
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
  // the keys walk the parts the card draws; a link's target (a part only a click reaches) is not on the way
  const walk = parts.filter(p => !p.link).map(p => p.id)
  const step = dir => () => {
    if (!walk.length) return null
    const i = walk.indexOf(region)
    return pick(walk[i < 0 ? 0 : (i + dir + walk.length) % walk.length])
  }
  k.on('up', step(-1), 'part')
  k.on('down', step(1), 'part')
  k.on('tab', step(1))
  k.on('shift+tab', step(-1))
  // the terminal's ring on a part, the browser's click on one
  k.on('focus', e => (e.region && ids.includes(e.region) ? pick(e.region) : null))
  const zoom = namedKnob(data.drawing, 'zoom') || (data.controls || []).find(c => c.id === 'zoom' || String(c.label || '').toLowerCase().includes('zoom')) || null
  const filter = (data.controls || []).find(c => c.id === 'filter' || String(c.label || '').toLowerCase().includes('filter')) || null
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
    // a link to a knob (its dial, or words that point at it): the knob turns, a step back on its left half, on on its right
    const linked = parts.find(p => p.id === r && p.link)
    if (linked && linked.knob) return turnCard(linked.knob, e.dir || 1)
    // a link to a cite or to examples opens what it points at: the cite's rows, the examples
    if (linked && r !== region) return { region: r, ex: 0, bar: linked.examples ? 'examples' : 'details' }
    if (!r || !ids.includes(r)) return null
    if (e.dir) return turnCard(r, e.dir)
    // a press on the selected part fills the bar with its details (and empties it again)
    if (r === region) return { bar: barAfter(bar, 'details') }
    return pick(r)
  })
  if (bar === 'examples') {
    k.on('[', () => ({ ex: ex - 1 }), 'flip')
    k.on(']', () => ({ ex: ex + 1 }), 'flip')
    k.on('e', () => ({ bar: barAfter(bar, 'examples') }), 'hide examples')
    // the record shown, checked by its label value's number
    const shown = shownExample(k, data, part, ex)
    const lab = shown && checkable(data, shown.labels)
    if (lab) {
      lab.values.forEach((v, i) => {
        if (i < 9) k.on(String(i + 1), () => { k.do('check', { label: lab.name, ref: shown.ref, value: v }); return { ex: ex + 1 } }, v)
      })
    }
  } else {
    // ↵ the details, e the examples; ] [ open the examples on their first
    k.on('return', () => ({ bar: barAfter(bar, 'details') }), bar ? undefined : 'details')
    k.on('e', () => ({ bar: barAfter(bar, 'examples'), ex: 0 }), 'examples')
    k.on(']', () => ({ bar: 'examples', ex: 0 }))
    k.on('[', () => ({ bar: 'examples', ex: 0 }))
  }
  if (bar || prog) k.on('0', () => (prog ? { prog: false } : { bar: barAfter(bar, 'back') }), 'clear')
  if (zoom) {
    const zoomed = data.cardState && Object.keys(data.cardState).length
    // + zooms into the selected part when the zoom has a level for it (a station `rerun-loop` for the part
    // `st-rerun-loop`), else one level in; − goes back out to the overview
    const into = (zoom.values || []).find(v => typeof v === 'string' && v && region && (region === v || region.endsWith(`-${v}`) || region === `st-${v}`))
    const zoomIn = () => {
      const state = into != null && zoom.values[zoom.i] !== into ? { ...data.cardState, [zoom.id]: into } : turnKnob({ controls: data.controls }, data.cardState, zoom.id, 1)
      k.do('card', { state, knob: zoom.id })
      return { region: null, ex: 0 }
    }
    k.on('+', zoomIn, zoomed ? 'zoom' : 'zoom in')
    k.on('=', zoomIn)
    k.on('-', () => { k.do('card', { state: { ...data.cardState, [zoom.id]: zoom.values[0] }, knob: zoom.id }); return { region: null, ex: 0 } }, zoomed ? 'zoom' : undefined)
  }
  if (filter) k.on('f', () => { k.do('card', { state: cycleKnob(filter, data.cardState), knob: filter.id }); return { region: null, ex: 0 } }, 'filter')
  // , and . turn a knob a step: the one selected, else the card's page knob, else its only knob. With every page shown,
  // they go to the heading of the page before or after. Named in the bar when the card's own keys do not turn it
  const pk = (data.controls || []).find(c => c.pages) || null
  const knob = part && part.knob ? control(part.knob) : pk || ((data.controls || []).length === 1 ? data.controls[0] : null)
  if (knob) {
    const own = (data.cardOn || []).some(h => h.turn && h.turn.knob === knob.id && h.turn.dir)
    const go = dir => () => {
      if (all && all.knob === knob.id) {
        const at = pageOf(region)?.page || all.at
        return { region: pageId(Math.max(1, Math.min(all.n, at + dir)), ''), ex: 0 }
      }
      return turnCard(knob.id, dir)
    }
    k.on(',', go(-1), own ? undefined : `previous ${knob.label || knob.id}`)
    k.on('.', go(1), own ? undefined : `next ${knob.label || knob.id}`)
    k.on('<', go(-1))
    k.on('>', go(1))
  }
  // a: every page at once, or one at a time (the place kept: the part selected, on its page)
  if (pk) k.on('a', () => ({ pages: all ? 'one' : 'all' }), all ? `${pageOne(pk)} by ${pageOne(pk)}` : `all ${pagesOf(pk)}`)
  k.on('p', () => ({ prog: !prog }), prog ? 'closes the program' : 'program')
  const versions = data.versions || []
  // h steps back through every version, drafts included (named so while the header lists only the one shown)
  if (versions.length > 1) k.on('h', () => { k.do('version', { v: stepVersion(versions, data.v) }); return { ex: 0 } }, shownVersions(versions, data.v).length > 1 ? 'versions' : 'drafts')
  // esc closes what was opened last (the program over the card, else the bar with all it shows), then the detail
  k.on('esc', () => {
    if (prog) return { prog: false }
    if (bar) return { bar: null }
    k.do('close')
    return null
  }, 'back')

  if (region) k.select(region)

  // ---- the header: the title, the card's id and its versions
  const W = Math.max(30, k.w)
  // each version the person saw a part of the header (the one shown too): a press shows it. Versions saved before the
  // person saw the card (Claude fixing it within one turn) are drafts: not listed, h steps to them
  const listed = shownVersions(versions, data.v)
  const vs = listed.length > 1 ? listed.flatMap((x, i) => [
    ...(i ? [k.text('{dim: · }', { wrap: false })] : []),
    k.region(`ver-${x.v}`, { label: `v${x.v}${x.change ? ': ' + x.change : ''}${x.seen === false ? ' (a draft)' : ''}${x.drafts ? ` (${x.drafts} draft${x.drafts === 1 ? '' : 's'} before it)` : ''}` },
      k.text(x.v === data.v ? `{accent:**v${x.v}${x.seen === false ? ' draft' : ''}**}` : `{dim:v${x.v}}`, { wrap: false })),
  ]) : []
  const head = k.beside(
    k.text(`**${k.escape(data.title)}**`, { grow: 1, wrap: false }),
    k.text(`{dim:card:${k.escape(cut(data.id, 30))}}`, { wrap: false }),
    vs.length ? k.beside(vs, { gap: 0 }) : false,
    { gap: 2 },
  )
  // the takeaway: its citations of a part select that part (and the selected part's are bold)
  const take = String(data.text || data.question || '').replace(/\s+/g, ' ').trim()
  const refsOf = id => data.refs[id] || []
  const takeaway = take ? k.text(linkRuns(take).map(r => {
    const s = k.escape(r.s)
    if (!r.link) return r.bold ? `**${s}**` : s
    const to = partOfLink(r.link, parts, refsOf)
    return to ? (to === region ? `**[${s}](#${to})**` : `[${s}](#${to})`) : `{accent:${s}}`
  }).join('')) : false

  if (prog) return k.stack(head, takeaway, k.text(' '), programView(k, data, part, W))
  return k.stack(head, takeaway, k.text(' '), k.embed(data.drawing), barView(k, data, part, bar, ex, W))
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

/** A page knob's page in one word: `chapter` (its label, when one word), else `page`; and its pages: `chapters`. */
function pageOne(c) {
  const w = String(c.label || c.id).trim()
  return /^[a-z]+$/i.test(w) ? w.replace(/s$/i, '') : 'page'
}
function pagesOf(c) {
  const w = pageOne(c)
  return /[^aeiou]y$/i.test(w) ? w.slice(0, -1) + 'ies' : w + 's'
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

/** The example the bar shows now, with its labels, or null. */
function shownExample(k, data, part, ex) {
  if (!part) return null
  const { records } = exampleRecords(k, data, part)
  if (!records.length) return null
  const at = ((ex % records.length) + records.length) % records.length
  const rec = records[at]
  const ref = rec && typeof rec === 'object' && typeof rec.ref === 'string' ? rec.ref : null
  if (!ref) return null
  return { ref, labels: labelsOf(k, data, records)[ref] || {} }
}

/** The label a record is checked against: the card's own label when the record holds it, else its first. */
function checkable(data, labels) {
  const names = Object.keys(labels || {})
  const name = data.label && labels[data.label] ? data.label : names[0]
  if (!name) return null
  const e = labels[name]
  const values = Array.isArray(e.values) && e.values.length ? e.values : null
  return values ? { name, values, e } : null
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

/** The bar under the card: empty until asked, then the part's details, then its examples. Its rows stay the same while
 *  it is open, so the card above it never moves. */
function barView(k, data, part, bar, ex, W) {
  const rows = bar === 'examples' ? 4 + EXR : 4
  const out = [k.text(' ')]
  if (!bar || !part) { for (let i = 1; i < rows; i++) out.push(k.text(' ')); return k.stack(out) }
  const cite = part.cite ? data.cites[part.cite] : null
  const set = exampleSet({ examples: data.examples }, { examples: part.examples })
  const refs = data.refs[part.id] || []
  const resolved = refs.length ? k.want({ rows: refs, n: 8 }) : null
  const chain = resolved ? chainWords(resolved) : null
  const facts = k.want({ facts: data.id })
  const records = set ? set.records : chain && !chain.error ? chain.records : []
  const total = set ? (set.total ?? set.records.length) : resolved?.count ?? records.length
  // the part's claim, where it comes from, and the filter the card has on
  const claim = String(cite?.text || part.label || part.id).replace(/\*\*/g, '')
  const nrows = resolved?.count ?? (set ? set.total ?? set.records.length : cite ? (cite.rows?.length || 0) + (cite.more || 0) : null)
  const segs = fromLine(facts && !facts.error ? facts : { sources: cite?.source ? [{ path: cite.source }] : [] }, { rows: nrows, ...(cite?.source && !facts ? { source: cite.source } : {}) })
  const filter = (data.controls || []).find(c => c.id === 'filter')
  out.push(k.text(`**${k.escape(cut(claim, W))}**`, { wrap: false }))
  const tone = t => (t === 'warn' ? 'warn' : t === 'unseen' ? 'unseen' : 'dim')
  out.push(k.text(segs.map(x => (x.bold ? `**${k.escape(x.t)}**` : `{${tone(x.tone)}:${k.escape(x.t)}}`)).join('') + (filter && filter.i > 0 ? `{dim: · }{accent:filter on: ${k.escape(String(filter.shown[filter.i]))}}` : ''), { wrap: false }))
  // the labels that hold the part's rows, and how the rows split by each
  const split = resolved && !resolved.error ? splitWords(resolved.labels) : []
  if (split.length && bar !== 'examples') out.push(k.text(`{accent:label} ${split.map(x => k.escape(cut(x, W - 8))).join('{dim:  ·  }')}`, { wrap: false }))
  if (bar !== 'examples') return k.stack(out)
  // what the examples are examples of: the examples' own label, else the part's claim
  const of = String(set?.label || claim)
  const nrec = records.length
  const at = nrec ? (((ex % nrec) + nrec) % nrec) : 0
  const pos = nrec ? `${at + 1} of ${n(total)}` : ''
  out.push(k.text(' '))
  out.push(k.text(`{accent:examples of ${k.escape(cut(of, W - pos.length - 16))}}${pos ? `{dim: · ${pos}}` : ''}`, { wrap: false }))
  const labels = labelsOf(k, data, records)
  const body = []
  if (!nrec) {
    if (refs.length && !resolved) body.push(k.text('{dim:   reading the rows behind it…}'))
    else if (chain && chain.error) body.push(k.text(`{bad:   ${k.escape(chain.notes[0] || 'its rows could not be read')}}`))
    else body.push(k.text('{dim:   ░ no records behind this part}'))
  } else {
    const view = examplesView(records, { at, fit: EXR - 1, fmt: set?.fmt, fields: part.fields ?? set?.fields })
    if (view.kind === 'table') {
      const cols = view.cols
      const val = (r, key) => (r?.[key] == null ? '' : typeof r[key] === 'number' && !/(^|_)(id|step|epoch|run|rev|line|seq)$/i.test(key) ? n(r[key]) : String(r[key]))
      const widths = cols.map((key, i) => (i === cols.length - 1 ? 0 : Math.min(18, Math.max(key.length, ...view.rows.map(x => val(x.rec, key).length)))))
      const line = cells => cells.map((v, i) => (i === cells.length - 1 ? v : (v + ' '.repeat(widths[i] ?? 0)).slice(0, widths[i] ?? 0) + '  ')).join('')
      body.push(k.text(`{dim:    ${k.escape(line(cols))}}`, { wrap: false }))
      for (const r of view.rows) {
        const t = k.escape(cut(line(cols.map(key => val(r.rec, key))), W - 6))
        body.push(k.text(r.on ? `{accent:**  ▸ **}**${t}**` : `    ${t}`, { wrap: false }))
      }
    } else {
      for (const r of view.rows) {
        body.push(k.text(r.on ? `{accent:**  ▸ **}**${k.escape(cut(r.words || '', W - 6))}**` : `    {dim:${k.escape(cut(r.words || '', W - 6))}}`, { wrap: false }))
        const ref = records[r.i] && typeof records[r.i] === 'object' ? records[r.i].ref : null
        const tags = ref ? labelWords(labels[ref]) : ''
        body.push(tags
          ? k.text(`      {accent:${k.escape(cut(tags, W - 8))}}${r.meta ? `{dim:  ·  ${k.escape(cut(r.meta, Math.max(0, W - 12 - tags.length)))}}` : ''}`, { wrap: false })
          : k.text(`{dim:      ${k.escape(cut(r.meta || '', W - 8))}}`, { wrap: false }))
      }
    }
  }
  while (body.length < EXR - 1) body.push(k.text(' '))
  return k.stack(out, body.slice(0, EXR - 1))
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
  const h = Math.max(6, (data.h || 30) - 8)
  const top = Math.max(0, Math.min(first - 4, lines.length - h))
  for (let i = top; i < Math.min(lines.length, top + h); i++) {
    const hit = lit.has(i + 1)
    const num = String(i + 1).padStart(3)
    out.push(k.text(hit ? `{accent:**${num} ▌**} ${k.escape(cut(lines[i] || ' ', W - 8))}` : `{dim:${num} │} ${k.escape(cut(lines[i] || ' ', W - 8))}`, { wrap: false, raw: false }))
  }
  return k.stack(out)
}
