// Activity Timeline in the terminal: one agent transcript on a time axis, as view.html draws it in the browser. The top
// row searches, chooses Events or Density, and holds Filter by (which records show), Rows (what the lanes are grouped
// by — the tactic label where it has run, else a field such as Tool) and Color by (the one color, Tool to open). The
// time range's overview strip frames the part the lanes and the list show; the lanes draw a lane per group, their
// records' bars in the Color by hues (Events draws a mark per record instead), the list's rows in view on the selection
// background. A record opens in the side pane with a step into the transcript; choosing a lane shows that lane's
// records, named over the list. Labels: the reader keeps what the label filter keeps and gives each record its lane.
import { axis, colorBy, columns, details, divider, draw, fetch, filterBy, hms, lanes, list, num, onLabels, onOpen, onReset, redraw, rows, search, side, timeRange } from 'thimble-term'

const GUTTER = 16 // the lane names' and the readout's column
const TOOL_LABEL = { '': 'Reasoning', terminal: 'terminal', create_tool: 'create', view_tool: 'view', str_replace_tool: 'str_replace', insert_tool: 'insert' }
const FIELDS = [
  { name: 'tool', title: 'Tool', description: 'The tool the record called; Reasoning for a message with no tool call', value: (it) => it && it.tool },
  { name: 'role', title: 'Role', description: 'System (the one system prompt), Assistant, or Human (a context-compaction turn)', value: (it) => it && it.role },
]

let D = null, items = [], byRow = new Map(), loaded = false, seq = 0
const texts = new Map()
const recs = new Map() // r -> the record in full
const S = { lane: null, keep: [], density: false }

const colour = colorBy({
  fields: [
    { name: 'tool', title: 'Tool', description: FIELDS[0].description,
      values: [{ name: 'terminal' }, { name: 'Reasoning' }, { name: 'view' }, { name: 'create', colour: 5 }, { name: 'str_replace', colour: 6 }],
      meanings: { terminal: 'A shell command and its output', Reasoning: 'Reasoning or a reply, with no tool call', view: 'A file or folder read', create: 'A file written', str_replace: 'An edit to a file' },
      value: (it) => it && it.tool },
    { name: 'role', title: 'Role', description: FIELDS[1].description, value: (it) => it && it.role },
  ],
  initial: 'tool',
  onChange: () => redraw(),
})
const filter = filterBy({ fields: FIELDS, onChange: () => redraw() })
const rowsCtl = rows({ fields: FIELDS, initial: [{ label: 'tactic' }, 'tool'], onChange: load })
const range = timeRange({})
const q = search({ words: 'search records', onChange: () => redraw() })
const records = list({ key: (it) => it.r, enter: 'to read' })
const pane = side({})
const over = divider({})
const dense = () => S.density

const laneView = lanes({
  rows: rowsCtl,
  colour,
  time: (it) => it.t,
  density: dense,
  onPick: (lane) => { S.lane = lane.key === S.lane ? null : lane.key; redraw() },
  onMark: (it) => read(it.r),
})

onReset({ changed: () => S.lane !== null || records.open !== null || S.density, reset: () => { S.lane = null; S.density = false; records.show(records.chosen, false); pane.hide() } })
onLabels(() => load())

function flags() {
  const out = []
  for (const bd of (D && D.boundaries) || []) {
    const t = D.t0 + bd.t
    if (out.length && t - out[out.length - 1].t < 1800) continue
    out.push({ t, label: 'context compaction' })
  }
  return out
}

async function load() {
  const my = ++seq
  const COLS = ['r', 't', 'ln', 'ix', 'tool', 'role', 'typ', 'hu', 'g']
  const c = Object.fromEntries(COLS.map((k) => [k, []]))
  let first = null, from = 0
  try {
    do {
      const page = await fetch({ op: 'overview', from, rows: rowsCtl.query(), ...(S.keep && S.keep.length ? { keep: S.keep } : {}) }, { key: 'overview' })
      if (my !== seq) return
      if (!first) first = page
      for (const k of COLS) for (const x of page.cols[k] || []) c[k].push(x)
      from = page.next
    } while (from != null)
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  D = first
  items = []
  byRow = new Map()
  for (let i = 0; i < c.r.length; i++) {
    const it = {
      r: c.r[i], ref: `${D.file}#L${c.ln[i]}`, t: D.t0 + c.t[i], line: c.ln[i], ix: c.ix[i],
      tool: TOOL_LABEL[D.names.tool[c.tool[i]] || ''] || null, role: D.names.role[c.role[i]] || null,
      typ: D.names.typ[c.typ[i]], hu: !!c.hu[i], group: c.g[i] == null ? null : String(c.g[i]),
    }
    items.push(it)
    byRow.set(it.r, it)
  }
  const span = items.length ? [items[0].t, items[items.length - 1].t] : [0, 1]
  const pad = (span[1] - span[0]) * 0.004 || 60
  range.data({ span: [span[0] - pad, span[1] + pad], times: items.map((i) => i.t), values: items.map((i) => colour.valueOf(i)), marks: flags() })
  await fetchTexts(items.map((i) => i.r))
  loaded = true
  redraw()
}

async function fetchTexts(rowsWanted) {
  const want = rowsWanted.filter((r) => !texts.has(r))
  for (let p = 0; p < want.length; p += 1000) {
    const res = await fetch({ op: 'texts', rows: want.slice(p, p + 1000) })
    for (const [row, t] of res.texts) texts.set(row, t)
  }
}

const inWin = (it) => range.has(it.t)
const scoped = () => items.filter((it) => filter.keeps(it) && (!q.text.trim() || (texts.get(it.r) || '').toLowerCase().includes(q.text.trim().toLowerCase())))
const laneItems = () => scoped().filter(inWin)
const laneKeyOf = (it) => { const g = rowsCtl.groupOf(it); return g == null ? '' : String(g) }
const listItems = () => laneItems().filter((it) => S.lane === null || laneKeyOf(it) === (S.lane === '\u0000none' || S.lane === 'none' ? '' : S.lane))

function laneName(key) {
  for (const n of laneView.lanes) if (String(n.key) === String(key)) return n.name
  return key ? String(key) : 'Not marked'
}

async function read(r) {
  const it = byRow.get(r)
  if (!it) return
  if (S.lane !== null && laneKeyOf(it) !== (S.lane === 'none' ? '' : S.lane)) S.lane = null
  if (!range.has(it.t)) range.set(null)
  records.show(r)
  pane.show(r)
  redraw()
  if (!recs.has(r)) {
    recs.set(r, null)
    const res = await fetch({ op: 'record', r, ...(S.keep && S.keep.length ? { keep: S.keep } : {}) }, { key: 'record' })
    recs.set(r, res.record)
    redraw()
  }
}

onOpen(async (place) => {
  const t = (place && place.target) || {}
  if (t.r != null) {
    S.keep = [t.r]
    if (!D || !byRow.has(t.r)) await load()
    return read(t.r)
  }
  if (!loaded) await load()
})

function drawDetail(it, dd) {
  const rec = recs.get(it.r)
  if (!rec) { dd.row().add('◌ reading the record', { d: true }).end(); return }
  const blocks = []
  if (rec.type === 'ToolMessage') {
    if (rec.tool_call != null) blocks.push({ code: true, text: typeof rec.tool_call === 'string' ? rec.tool_call : Object.entries(rec.tool_call).map(([k, v]) => `${k}: ${v}`).join('\n') })
    if (rec.tool_result != null) blocks.push({ text: String(rec.tool_result) })
  }
  details(dd, {
    text: rec.type === 'ToolMessage' ? '' : rec.content || '',
    blocks,
    facts: [['role', rec.role], ['tool', rec.tool ? TOOL_LABEL[rec.tool] || rec.tool : TOOL_LABEL['']], ['time', (rec.time || '').replace('T', ' ').replace('Z', '')]],
    place: rec.ref,
    ask: { ref: rec.ref, text: texts.get(it.r) || '' },
  })
}

draw((d) => {
  // the top row: the search, Events | Density, Filter by, then Color by with Rows before it and Reset at R
  const r1 = d.row()
  q.add(r1).gap()
  // Events | Density, the active one upright, the other dim; a click or the mark switches it
  r1.add('Events', S.density ? { d: true } : {}, { on: () => { S.density = false; redraw() }, tip: 'draw a mark per record' })
  r1.add(' ').add('Density', S.density ? {} : { d: true }, { on: () => { S.density = true; redraw() }, tip: "draw each lane's records as bars per bin" })
  r1.gap()
  filter.add(r1, { max: Math.max(10, r1.room - 18) })
  r1.end()
  colour.draw(d, (r) => { rowsCtl.add(r).gap() })
  if (!loaded) { d.row().add('◌ reading the records', { d: true }).end(); return }
  // the overview: the time range's strip and a lane per group, their height set by the divider; the axis under them
  const overRows = over.rows(d, Math.min(d.left - 4, 10))
  range.draw(d, { gutter: GUTTER })
  const scale = range.scale(d.cols - GUTTER)
  laneView.draw(d, { items: laneItems(), scale, gutter: GUTTER, room: Math.max(1, overRows - 3), span: records, density: dense() })
  axis(d, scale, { gutter: GUTTER, legend: laneView.legend(), marks: flags() })
  d.blank()
  // the records of the range, named over them; a record opens in the side pane
  const shown = listItems()
  const title = S.lane !== null ? laneName(S.lane) : rowsCtl.by ? `All ${rowsCtl.by.title.toLowerCase()} lanes` : 'All records'
  // the row's columns fit the width the list is drawn at (narrower beside the side pane): the tool column drops when the
  // list is narrow, the first line always grows into what is left
  const colsAt = new Map()
  const cellsFor = (r) => {
    const w = r.d.cols - r.x
    let c = colsAt.get(w)
    if (!c) { const wt = w >= 72 ? 13 : 0; c = { wt, cols: columns([{ w: 8 }, ...(wt ? [{ w: wt }] : []), { grow: true }], w) }; colsAt.set(w, c) }
    return c
  }
  records.draw(d, {
    items: shown,
    colour,
    value: (it) => colour.valueOf(it),
    side: pane,
    sideTitle: (it) => `#${it.ix} · ${it.tool || 'Reasoning'}`,
    title,
    count: `${num(shown.length)} ${shown.length === 1 ? 'record' : 'records'}`,
    empty: 'no record passes these filters',
    row: (it, r) => { const c = cellsFor(r); c.cols.cells(r, [hms(it.t), ...(c.wt ? [it.tool || '—'] : []), texts.get(it.r) || ''], [{ d: true }, ...(c.wt ? [{ d: true }] : []), {}]) },
    onOpen: (it) => { if (!recs.has(it.r)) read(it.r) },
    ask: (it) => ({ ref: it.ref, text: texts.get(it.r) || '' }),
    detail: drawDetail,
  })
})

load()
