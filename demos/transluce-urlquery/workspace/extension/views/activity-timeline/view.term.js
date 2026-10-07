// Activity Timeline in the terminal: every URLQuery report on one UTC time axis, as view.html draws it in the browser.
// The top row searches, picks what the lanes are grouped by (Rows: a data source by default, or a field or a label),
// which reports show (Filter by) and the one color (Color by); the time range's strip picks the time the lanes and the
// list show. A lane per group draws its reports per cell in the Color by hues; under it, past the divider, the list
// holds the same lanes in the same order, each with its reports, its episodes, its first and last report and its reports
// over its own span. A lane chosen opens its episodes in the side pane, the bursts of its reports less than two hours
// apart, each a heading over its reports; a report there opens in full in the pane. The span of the pane's reports in
// view is marked across the lanes. One fetch gives every report the label filter keeps, with the marks of the labels the
// controls read; a report in full comes when it opens.
import {
  axis, colorBy, columns, cut, details, divider, draw, fetch, filterBy, lanes, list, num, onLabels, onOpen, onReset, plural,
  redraw, rows as rowsControl, search, side, strip, timeRange, width, COLORS,
} from 'thimble-term'

const DAY = 86400
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FIELDS = ['lane', 'confidence', 'disposition', 'broad_class', 'source_basis', 'catalog', 'why_included']
const NONINC = new Set(['Review required', 'Background control'])
const NO_CONF = 'no confidence'

// ---------------------------------------------------------------- time, in UTC
const dt = (t) => new Date(t * 1000)
const pad2 = (n) => String(n).padStart(2, '0')
const hms = (t) => dt(t).toISOString().slice(11, 19)
const hm = (t) => dt(t).toISOString().slice(11, 16)
const isoDay = (t) => dt(t).toISOString().slice(0, 10)
const dm = (t) => `${dt(t).getUTCDate()} ${MONTH[dt(t).getUTCMonth()]}`
const dmy = (t) => `${dm(t)} ${dt(t).getUTCFullYear()}`
const epWords = (a, b) => `${WEEKDAY[dt(a).getUTCDay()]} ${dmy(a)} ${hm(a)}${b > a ? ` – ${isoDay(a) === isoDay(b) ? hm(b) : `${dm(b)} ${hm(b)}`}` : ''}`
function dur(s) {
  s = Math.max(0, Math.round(s))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`
  if (s < DAY) return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`
  return `${Math.floor(s / DAY)}d ${Math.floor((s % DAY) / 3600)}h`
}
const gapText = (s) => (s < 60 ? `+${s}s` : s < 3600 ? `+${Math.floor(s / 60)}m` : `+${Math.floor(s / 3600)}h`)

// ---------------------------------------------------------------- the fields the controls offer
const FIELDS_BY = [
  {
    name: 'confidence', title: 'Confidence', description: "The catalog's qualitative confidence in agent-like activity, not a probability; blank for reports that need review and background controls",
    values: [{ name: 'significant', colour: 2 }, { name: 'suggestive', colour: 1 }],
    meanings: { significant: 'Higher confidence in agent-like activity', suggestive: 'Moderate confidence in agent-like activity' },
  },
  {
    name: 'broad_class', title: 'Class', description: "The report's primary method class",
    values: [{ name: 'source_request' }, { name: 'indirection' }, { name: 'custom_program' }],
    meanings: {
      source_request: 'A request to a data source a task uses', indirection: 'A reader or proxy URL for a task target, or a static page that publishes task data',
      custom_program: 'Submitted content with task-specific fetch, form or API logic',
    },
  },
  {
    name: 'disposition', title: 'Disposition', description: 'Whether the collection counts the report',
    values: [{ name: 'included' }, { name: 'review_required' }, { name: 'background' }],
    meanings: { included: 'Counted, with a confidence and a data source', review_required: 'Needs review; no confidence and no data source', background: 'A background control; no confidence and no data source' },
  },
  {
    name: 'source_basis', title: 'Source basis', description: "How report-sources.csv assigned the report's data source; blank for a report it has no row for",
    values: [{ name: 'source_method' }, { name: 'unidentified' }, { name: 'external_source_tag' }, { name: 'selection_provenance' }, { name: 'supplement_review' }],
    meanings: {
      source_method: 'From the collection method whose query found the report', unidentified: 'No data source identified',
      external_source_tag: 'From a source tag imported from outside the collection', selection_provenance: "From the report's row in selection-provenance.csv, for the reports added in v5",
      supplement_review: "From the supplement's review",
    },
  },
  {
    name: 'catalog', title: 'Catalog', description: 'Which catalog lists the report',
    values: [{ name: 'main' }, { name: 'supplemental' }],
    meanings: { main: 'Listed in reports.csv, the main catalog', supplemental: 'Listed in additional-cited-reports.csv, the supplemental catalog' },
  },
]
const LANE_FIELD = { name: 'lane', title: 'Data source', description: "The report's data_source in report-sources.csv; the reports it has no row for in Review required or Background control by their disposition" }

// ---------------------------------------------------------------- state
let D = null // the reader's first page: names, short forms, lanes, marks, files
let R = [] // every report the label filter keeps, in time order: {i, r, t, ref, id, lane, …the fields, mb, value, group, fv}
let at = new Map() // a reader row -> its report
let found = null // the reader rows the search holds, or null
let GROUPS = [] // the lanes, in order: {key, name, unit, non}
let GAP = 7200
let seq = 0
let loaded = false
const records = new Map() // a report opened in full -> its record
const S = { report: null } // the report the pane shows in full

const colour = colorBy({ fields: FIELDS_BY, chips: 'filter', onChange: () => assign() })
const q = search({ words: 'search reports', onChange: (text) => doSearch(text) })
const range = timeRange({ onChange: () => {} })
let rowsC = null
let filter = null
const pane = side({ key: 'episodes', width: 0.5 })
const div = divider({ key: 'overview' })
const laneList = list({ key: (g) => g.key })
const epList = list({ key: (it) => it.r, enter: 'to open in full' })
const ln = lanes({
  groups: () => SHOWN,
  onPick: (n) => chooseLane(n.key),
  onMark: (it) => openReport(it),
  words: { record: 'report' },
})
// what Reset puts back of the view's own: the report open in full (the kit closes the pane and puts back the rest)
onReset({ changed: () => S.report !== null, reset: () => { S.report = null } })
onLabels(() => load())

// ---------------------------------------------------------------- the reports
// while the reports load, the words that say so change every TICK ms, and after each CHUNK reports decoded, so the
// view's frames show it reads them
const TICK = 120
const CHUNK = 6000
let ticks = 0
let ticker = null
let decoded = 0
const yieldFrame = () => {
  ticks++
  redraw()
  return new Promise((ok) => setTimeout(ok, 0))
}
function reading(on) {
  if (on && !ticker) ticker = setInterval(() => { ticks++; redraw() }, TICK)
  if (!on && ticker) { clearInterval(ticker); ticker = null }
}
async function load() {
  const my = ++seq
  const parts = []
  let from = 0
  reading(true)
  try {
    do {
      const page = await fetch({ op: 'overview', from }, { key: 'overview' })
      if (my !== seq) return
      parts.push(page)
      from = page.next
    } while (from != null)
  } catch (e) {
    reading(false)
    if (e.name === 'AbortError') return
    throw e
  }
  await yieldFrame()
  if (my !== seq) return
  const first = parts[0]
  const A = first.alphabet
  const code = new Int16Array(128)
  for (let k = 0; k < A.length; k++) code[A.charCodeAt(k)] = k
  const out = []
  for (const p of parts) {
    let r = p.start - 1
    let tt = 0
    let lnn = 0
    let sl = 0
    const cols = {}
    for (const [f, { w, s }] of Object.entries(p.codes)) {
      const col = new Array(p.n)
      for (let j = 0; j < p.n; j++) {
        let v = 0
        for (let k = 0; k < w; k++) v = v * 64 + code[s.charCodeAt(j * w + k)]
        col[j] = v
      }
      cols[f] = col
    }
    const mb = new Map(p.mb)
    for (let j = 0; j < p.n; j++) {
      if (j && j % CHUNK === 0) {
        decoded = out.length
        await yieldFrame()
        if (my !== seq) return
      }
      r += p.r ? p.r[j] : 1
      tt += p.t[j]
      lnn += p.ln[j]
      if (p.sl[j]) sl += p.sl[j]
      const rec = { r, t: first.t0 + tt, ref: `${first.files.all}#L${lnn}`, id: p.ids.substr(j * first.id_chars, first.id_chars).trim(), mb: mb.get(j) || 0 }
      for (const f of FIELDS) rec[f] = first.names[f][cols[f][j]] || ''
      rec.why = first.short[cols.why_included[j]] || rec.why_included
      out.push(rec)
    }
  }
  D = first
  GAP = first.gap || 7200
  R = out
  at = new Map(R.map((rec) => [rec.r, rec]))
  if (!rowsC) {
    const fields = [{ ...LANE_FIELD, values: D.lanes.map((c) => D.names.lane[c]) }, ...FIELDS_BY]
    rowsC = rowsControl({ fields, initial: 'lane', onChange: () => assign() })
    filter = filterBy({ fields, onChange: () => assign() })
  }
  decoded = out.length
  await yieldFrame()
  if (my !== seq) return
  loaded = true
  assign()
  reading(false)
}

// a report's value of a label, from the marks the reader handed it
const markKeys = (by) => (D && D.marks ? D.marks.map((m, k) => (m.id != null ? String(m.id) === String(by.label) : m.label === by.title) ? k : -1).filter((k) => k >= 0) : [])
function labelValue(rec, keys) {
  if (!rec.mb) return null
  for (const k of keys) if (rec.mb & (1 << k)) return D.marks[k].value
  return null
}
// a report's value under a choice: its field's ('' none), or a label's from its marks
function valueUnder(by) {
  if (!by) return () => null
  if (by.field) return (rec) => rec[by.field] || null
  const keys = markKeys(by)
  return (rec) => labelValue(rec, keys)
}

// each report's Color by value (a label's, which the kit takes as `value`), its lane (`group`) and its Filter by value
// (`fv`), and the lanes in order: a data source's as the reader orders them (the largest first, the reports not included
// last), a field's in its declared order then by size, a label's every class, then the reports it does not mark
function assign() {
  if (!D) return
  const cb = colour.label ? { label: colour.label, title: (colour.by || {}).title } : null
  const cv = cb ? valueUnder(cb) : null
  const by = rowsC ? rowsC.by : null
  const gv = valueUnder(by)
  const fv = valueUnder(filter ? filter.by : null)
  for (const rec of R) {
    if (cv) rec.value = cv(rec)
    else delete rec.value
    rec.group = gv(rec)
    rec.fv = fv(rec)
  }
  if (!by) GROUPS = [{ key: '*', name: 'all reports' }]
  else if (by.field === 'lane') GROUPS = D.lanes.map((c) => ({ key: D.names.lane[c], name: D.names.lane[c], unit: D.keys[String(c)], non: NONINC.has(D.names.lane[c]) }))
  else if (by.label) {
    const l = D.marks.filter((m, k) => markKeys(by).includes(k)).map((m) => m.value)
    GROUPS = [...new Set(l)].map((v) => ({ key: v, name: v }))
    GROUPS.push({ key: '', name: 'not marked' })
  } else {
    const n = new Map()
    for (const rec of R) n.set(rec.group || '', (n.get(rec.group || '') || 0) + 1)
    const def = FIELDS_BY.find((f) => f.name === by.field)
    const declared = def ? def.values.map((v) => v.name) : []
    const keys = [...n.keys()].filter((k) => k !== '').sort((a, b) => ((declared.indexOf(a) + 1 || 1e9) - (declared.indexOf(b) + 1 || 1e9)) || n.get(b) - n.get(a))
    GROUPS = keys.map((k) => ({ key: k, name: k }))
    if (n.has('')) GROUPS.push({ key: '', name: by.field === 'confidence' ? NO_CONF : `no ${by.title.toLowerCase()}` })
  }
  const times = []
  const values = []
  for (const rec of R) if (passes(rec)) { times.push(rec.t); values.push(colour.valueOf(rec)) }
  range.data({ times, values, span: [Math.floor(D.t0 / DAY) * DAY, Math.floor(D.t1 / DAY) * DAY + DAY] })
  redraw()
}

// whether a report shows: the search holds it, Filter by keeps its value, its Color by chip is on
function passes(rec, skip) {
  if (found && !found.has(rec.r)) return false
  if (skip !== 'filter' && filter && filter.by && !filter.isOn(rec.fv)) return false
  if (skip !== 'colour' && !colour.keeps(rec)) return false
  return true
}

async function doSearch(text) {
  const t = String(text || '').trim()
  if (!t) {
    found = null
    return assign()
  }
  let res
  try {
    res = await fetch({ op: 'search', q: t }, { key: 'search' })
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  found = new Set(res.rows)
  assign()
}

// ---------------------------------------------------------------- the lanes and their rows
// SHOWN: the lanes the range shows, each {key, name, depth, guide, items, children, n, eps, first, last}: the whole span
// shows every lane with a report that passes, a range those with one in it and the chosen one
let SHOWN = []
function laneGroups() {
  const by = new Map(GROUPS.map((g) => [g.key, []]))
  const ever = new Map()
  for (const rec of R) {
    if (!passes(rec)) continue
    const k = rec.group ?? (rowsC && rowsC.by ? '' : '*')
    ever.set(k, (ever.get(k) || 0) + 1)
    if (range.has(rec.t) && by.has(k)) by.get(k).push(rec)
  }
  const chosen = pane.isOpen ? pane.key : null
  const always = rowsC && rowsC.by && rowsC.by.label
  const out = []
  for (const g of GROUPS) {
    const items = by.get(g.key) || []
    if (!(range.full ? ever.get(g.key) || always : items.length) && g.key !== chosen) continue
    let eps = 0
    let last = -Infinity
    for (const it of items) {
      if (it.t - last >= GAP) eps++
      last = it.t
    }
    out.push({ ...g, depth: 0, guide: '', children: 0, items, n: items.length, eps, first: items.length ? items[0].t : null, last: items.length ? items[items.length - 1].t : null })
  }
  // the reports not included after the data sources
  return [...out.filter((g) => !g.non), ...out.filter((g) => g.non)]
}
// a lane's reports over its own span, a cell per slice, each the bar of its reports in the hue most of them take
function spark(g, w) {
  if (!g.items.length || w < 3) return [{ s: ' '.repeat(Math.max(0, w)) }]
  const a = g.first
  const span = g.last - a
  const scale = { cols: w, binOf: (t) => (span > 0 ? Math.min(w - 1, Math.floor(((t - a) * w) / span)) : Math.floor(w / 2)) }
  return strip(scale, g.items, { value: (it) => colour.valueOf(it), colour })
}

// the value most of a lane's reports take, its mark in the list and its share of the track
function mainValue(g) {
  const n = new Map()
  for (const it of g.items) {
    const v = colour.valueOf(it)
    if (v !== null) n.set(v, (n.get(v) || 0) + 1)
  }
  let best = null
  let bn = 0
  for (const [v, k] of n) if (k > bn) [best, bn] = [v, k]
  return best
}

// the chosen lane's reports in the range, split into episodes where two lie GAP or more apart: a heading for each, cut
// to the pane's `cols`, then its reports
function episodes(g, cols) {
  const items = []
  let cur = null
  let count = 0
  for (const it of g.items) {
    if (!cur || it.t - cur.last >= GAP) {
      cur = { first: it.t, last: it.t, n: 0, head: { heading: '' } }
      items.push(cur.head)
      count++
    }
    cur.last = it.t
    cur.n++
    cur.head.heading = cut(`${epWords(cur.first, cur.last)}${cur.last > cur.first ? ` · ${dur(cur.last - cur.first)}` : ''} · ${plural(cur.n, 'report')}`, cols)
    items.push(it)
  }
  return { items, count }
}

function chooseLane(key) {
  S.report = null
  laneList.choose(key)
  if (pane.key === key) pane.hide()
  else pane.show(key)
}

async function openReport(rec) {
  const g = rec.group ?? (rowsC && rowsC.by ? '' : '*')
  laneList.choose(g)
  if (pane.key !== g) pane.show(g)
  if (!range.has(rec.t)) range.set(null)
  epList.choose(rec.r)
  S.report = rec.r
  redraw()
  if (records.has(rec.r)) return
  records.set(rec.r, null)
  try {
    records.set(rec.r, await fetch({ op: 'report', r: rec.r }, { key: 'report' }))
  } catch (e) {
    records.delete(rec.r)
    if (e.name !== 'AbortError') throw e
  }
  redraw()
}

// a report in full in the pane: its words, its rows' facts, its provenance and decisions, its place
function drawReport(rec, dd) {
  const back = dd.row()
  const goBack = () => {
    epList.show(rec.r, false)
    S.report = null
    redraw()
  }
  back.add('‹ episodes', { fg: COLORS.link }, { on: goBack, tip: "back to the lane's episodes" })
  back.gap().add(`${dmy(rec.t)} ${hms(rec.t)}`, { d: true })
  back.end()
  dd.key('backspace', 'to go back', goBack, true)
  const got = records.get(rec.r)
  if (!got) {
    dd.row().add('◌ reading the report', { d: true }).end()
    return
  }
  const facts = [['confidence', got.confidence || NO_CONF], ['class', got.broad_class], ['disposition', got.disposition], ['report_id', got.report_id]]
  if (got.source) facts.push(['data_source', got.source.data_source], ['source_basis', got.source.source_basis], ['matched_sources', got.source.matched_sources])
  const more = []
  if (got.provenance) more.push({ text: `provenance: ${['source_batch', 'group', 'source', 'record_kind', 'selection_basis', 'description'].map((k) => got.provenance.record[k]).filter(Boolean).join(' · ')}` })
  if (got.supplement) more.push({ text: `supplemental decision: ${got.supplement.record.basis || ''} · ${got.supplement.record.reason || ''}` })
  if (got.override) more.push({ text: `confidence change: ${got.override.record.previous_confidence} → ${got.override.record.confidence} · ${got.override.record.reason || ''}` })
  details(dd, {
    text: got.why_included,
    maxRows: 4,
    facts,
    blocks: more.map((m) => ({ text: m.text, max: 3 })),
    place: got.ref,
    ask: { ref: got.ref, text: got.why_included },
  })
}

// ---------------------------------------------------------------- places
// a report opens in full in the pane, in its lane; a lane with its episodes (a data source's under Rows by data source);
// an episode, a day or a window zoomed to
onOpen(async (place) => {
  const t = (place && place.target) || {}
  if (!loaded) await load()
  if (t.r != null) {
    const rec = at.get(t.r)
    if (rec) {
      if (!passes(rec)) q.set('')
      return openReport(rec)
    }
    return
  }
  if (t.lane != null && D) {
    if (rowsC && (!rowsC.by || rowsC.by.field !== 'lane')) rowsC.choose('lane')
    assign()
    const key = D.names.lane[t.lane]
    S.report = null
    laneList.choose(key)
    pane.show(key)
  }
  if (t.from != null) range.set(t.from, t.to)
  else if (t.lane != null) range.set(null)
})

// ---------------------------------------------------------------- the drawing
draw((d) => {
  // the top row: the search, Rows, Filter by and Color by with its chips, Reset at R; in a narrow panel the search and
  // Rows on a row of their own, Filter by on the next
  if (d.cols < 80) {
    const top = d.row()
    q.add(top).gap()
    if (rowsC) rowsC.add(top)
    top.end()
    if (filter) filter.add(d.row(), { max: d.cols }).end()
    colour.draw(d)
  } else {
    colour.draw(d, (r) => {
      q.add(r).gap()
      if (rowsC) rowsC.add(r).gap()
      if (filter) filter.add(r, { max: Math.max(14, Math.floor(d.cols * 0.32)) }).gap()
    })
  }
  if (!loaded) {
    d.row().add(`◌ reading the reports${decoded ? ` · ${num(decoded)}` : ''}${'.'.repeat(ticks % 4)}`, { d: true }).end()
    return
  }
  SHOWN = laneGroups()
  const longest = SHOWN.reduce((w, g) => Math.max(w, width(g.name)), 6)
  const gutter = Math.max(10, Math.min(longest + 3, Math.floor(d.cols * 0.3)))
  range.draw(d, { gutter })
  const scale = range.scale(d.cols - gutter)
  // the overview's rows: the divider's share of the rows left, the lanes and their axis
  const room = div.rows(d, Math.max(4, Math.min(SHOWN.length + 1, Math.round(d.left * 0.42))))
  const showsEpisodes = pane.isOpen && S.report === null
  ln.draw(d, { items: SHOWN.flatMap((g) => g.items), scale, gutter, room: Math.max(1, room - 1), span: showsEpisodes ? epList : null })
  axis(d, scale, { gutter })
  // the lanes again as a list, in the same order
  const total = SHOWN.reduce((n, g) => n + g.n, 0)
  const wide = d.cols >= 100
  const mid = d.cols >= 70
  const specs = wide
    ? [{ w: Math.min(24, Math.max(10, longest)) }, { w: 7, align: 'right' }, { w: 4, align: 'right' }, { w: 12 }, { grow: true, min: 6 }, { w: 12 }]
    : mid
      ? [{ w: Math.min(18, Math.max(10, longest)) }, { w: 7, align: 'right' }, { w: 6 }, { grow: true, min: 6 }, { w: 6 }]
      : [{ grow: true, min: 10 }, { w: 7, align: 'right' }, { w: 10 }]
  const listCols = pane.isOpen ? null : columns(specs, d.cols - 6)
  const whenCell = (t) => (t === null ? '' : wide ? `${dmy(t)}` : dm(t))
  laneList.draw(d, {
    items: SHOWN,
    title: rowsC && rowsC.by ? rowsC.by.title : 'Lanes',
    count: `${plural(SHOWN.length, 'lane')} · ${plural(total, 'report')}`,
    colour,
    value: mainValue,
    empty: 'no report passes these filters in this range',
    header: listCols ? (r) => listCols.header(r, wide ? ['', 'reports', 'eps', 'first', '', 'last'] : mid ? ['', 'reports', 'first', '', 'last'] : ['', 'reports', '']) : null,
    row: (g, r) => {
      // beside the open pane the lane's name and its reports alone
      if (!listCols) {
        r.add(g.name, {}, { max: Math.max(4, r.room - 9) }).right(num(g.n), { d: true })
        return
      }
      const w = listCols.widths
      const cells = wide ? [g.name, num(g.n), num(g.eps), whenCell(g.first), null, whenCell(g.last)] : mid ? [g.name, num(g.n), whenCell(g.first), null, whenCell(g.last)] : [g.name, num(g.n), null]
      const sparkAt = cells.indexOf(null)
      cells.forEach((v, i) => {
        if (i) r.gap(2)
        if (i === sparkAt) return r.runsOf(spark(g, w[i]))
        const text = String(v)
        const style = i === 0 ? {} : { d: true }
        const s = i === 0 ? text.slice(0, w[i]).padEnd(w[i]) : (wide ? i === 1 || i === 2 : i === 1) ? text.padStart(w[i]) : text.padEnd(w[i])
        r.add(width(text) > w[i] ? `${text.slice(0, w[i] - 1)}…` : s, style)
      })
    },
    side: pane,
    sideTitle: (g) => g.name,
    onOpen: () => { S.report = null },
    ask: (g) => (g.unit ? { ref: `view:activity-timeline/${g.unit}`, text: g.name } : null),
    detail: (g, dd) => {
      const rec = S.report !== null ? at.get(S.report) : null
      if (rec) return drawReport(rec, dd)
      const ep = episodes(g, Math.max(10, dd.cols - 4))
      epList.draw(dd, {
        items: ep.items,
        title: plural(ep.count, 'episode'),
        count: plural(g.n, 'report'),
        colour,
        empty: 'no report of this lane passes these filters in this range',
        row: (it, r) => {
          const i = ep.items.indexOf(it)
          const prev = i > 0 && !ep.items[i - 1].heading ? ep.items[i - 1] : null
          r.add(hms(it.t), { d: true }).gap()
          r.add(prev ? gapText(it.t - prev.t).padStart(5) : '     ', { d: true }).gap()
          if (dd.cols >= 60) r.add(it.id, { d: true }).gap()
          r.add(it.broad_class, { d: true }).gap()
          r.add(it.why, {}, { max: Math.max(4, r.room) })
        },
        onOpen: (it) => openReport(it),
        ask: (it) => ({ ref: it.ref, text: it.why }),
      })
    },
  })
})

load()
