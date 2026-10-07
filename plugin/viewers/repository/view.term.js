// Repository in the terminal: several agent runs on one small library, as view.html draws it in the browser. The top
// row searches, picks the kind of item (pull requests, issues, discussions or agents) and colors by its state, run,
// area or a label. The time range's overview strip shows the runs' activity, each run's day a stretch of its own and
// the nights between them breaks. The table lists the items active in the range, each row with the columns its kind
// fills and its records as marks on the range's scale, so the rows read as small multiples of one time; a row opens in
// place with the same issue in every run and its records in time order. One fetch gives the kind's items that the
// label filter and Color by keep; the search and the range narrow them here.
import { COLORS, choice, clip, colorBy, cut, details, draw, fetch, list, mark, onLabels, onOpen, onReset, open, pad, placeWords, search, timeRange, view, when, width, wrap } from 'thimble-term'

const KINDS = [
  { name: 'pull requests', value: 'pulls' },
  { name: 'issues', value: 'issues' },
  { name: 'discussions', value: 'discussions' },
  { name: 'agents', value: 'agents' },
]
const TAB = { pull: 'pulls', issues: 'issues', discussions: 'discussions', agents: 'agents' } // the kind a key names in its second part
// the columns between the title and the activity, each shown while an item of the kind has a value in it and the
// width holds it (`from` cells): the area from 100, the author from 80; the area is gray, as in the browser
const COLS = [{ key: 'area', from: 100, d: true }, { key: 'author', from: 80 }, { key: 'state', from: 0 }]
const slug = view().slug || 'repository'

let data = null // the reader's answer for the kind (reader.py _view): {tab, items, counts, runs}
let loading = null // the newest load, which a citation waits for after it changed the kind
let want = null // a place a citation opened before the items arrived
let focus = null // the record a citation opened, marked and kept in view in its item's details
const units = new Map() // an item opened in place -> its records (reader.py _detail), null while they are read

const colour = colorBy({
  // each field says what it is (from view.json's records), and `meanings` what the values the forge fixes mean
  // (reader.py's notes), which the menu and a chip's tip show; a run or an area shows what the field is
  fields: [
    {
      name: 'state', title: 'State', description: 'A pull request open, merged or closed by its records; an issue fixed once a pull request that fixes it merged',
      meanings: {
        open: 'A pull request neither merged nor closed, or an issue no merged pull request fixes yet', merged: 'A pull request merged',
        closed: 'A pull request closed without a merge', fixed: 'An issue that a merged pull request fixes',
      },
    },
    { name: 'run', title: 'Run', description: 'The run whose folder holds the item' },
    { name: 'area', title: 'Area', description: 'The first label, else the area of the issue it fixes' },
  ],
  chips: 'filter',
  onChange: () => load(),
})
// the runs fall on different days, so the nights between them are breaks
const range = timeRange({ gap: 4 * 3600 })
const q = search({ words: 'search' })
const kind = choice({ title: 'items', all: false, key: 'i', values: KINDS, onChange: () => {
  rows.show(null, false)
  load()
} })
const rows = list({ key: (it) => it.key })
onReset({ changed: () => rows.open !== null, reset: () => {
  rows.show(rows.chosen, false)
  focus = null
  load()
} })
// the label filter or a label's values changed: fetch again, since the reader keeps only what the filter keeps
onLabels(() => load())

function load() {
  return (loading = reload())
}

async function reload() {
  let got
  try {
    got = await fetch({ op: 'view', tab: kind.value, colour: colour.query() }, { key: 'view' })
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  data = got
  colour.counts(got.counts)
  // the overview: every record of the items Color by keeps, in the hue of its value
  const ev = got.items.flatMap((it) => it.events).filter((e) => colour.isOn(e[2]))
  range.data({ times: ev.map((e) => e[0]), values: ev.map((e) => e[2]) })
  units.clear()
  if (rows.open !== null) await readUnit(rows.open)
  if (want) go()
}

async function readUnit(key) {
  if (units.has(key)) return
  units.set(key, null)
  try {
    units.set(key, await fetch({ op: 'unit', key }, { key: 'unit' }))
  } catch (e) {
    units.delete(key)
    if (e.name !== 'AbortError') throw e
  }
}

// an item opened in place, on its kind, with the record `ref` marked: a citation, and an issue in another run, come here
async function show(key, ref = null) {
  const tab = TAB[key.split('/')[1]]
  if (!tab) return
  if (kind.value !== tab) {
    kind.set(tab)
    await loading
  }
  const it = data && data.items.find((i) => i.key === key)
  if (!it) return
  if (q.text && !it.search.includes(q.text.trim().toLowerCase())) q.set('')
  if (!range.full && !it.events.some((e) => range.has(e[0]))) range.set(null)
  focus = ref
  rows.show(key)
  await readUnit(key)
}

// a run's citation frames its span in the range; any other opens its item
function go() {
  const t = want
  want = null
  const run = t.run && data.runs.find((r) => r.run === t.run)
  if (run) range.set(run.start, run.end)
  else if (t.key) show(t.key, t.ref)
}

onOpen((place) => {
  want = (place && place.target) || null
  if (want && data) go()
})

// a run's name in the axis frames the run, and again the whole span
function frameRun(run) {
  if (Math.abs(range.from - run.start) < 1 && Math.abs(range.to - run.end) < 1) range.set(null)
  else range.set(run.start, run.end)
}

const idOf = (it) => `${it.run}${it.number != null ? ` #${it.number}` : ''}`
const plus = (n) => `+${n}`

// the cells a title wants: all of it, and its first flag and how many others there are
const titleWant = (it) => width(it.title) + (it.flags.length ? 2 + width(it.flags[0]) + (it.flags.length > 1 ? 5 : 0) : 0)

// the table's columns for the kind's items at this width: the item, the title, the columns its items fill and the
// width holds, and the activity, which takes at least 30% and what the titles leave, so it widens rather than the title
function layout(cols, items) {
  const room = cols - 6 // the row after its mark, before the track
  const shown = COLS.filter((c) => room >= c.from && items.some((it) => it[c.key]))
  const ws = [
    Math.max(4, ...items.map((it) => width(idOf(it)))),
    0,
    ...shown.map((c) => Math.min(12, Math.max(width(c.key), ...items.map((it) => width(it[c.key] || ''))))),
  ]
  const fixed = ws.reduce((a, b) => a + b, 0) + 2 * (shown.length + 2)
  ws[1] = Math.max(12, Math.min(Math.max(5, ...items.map(titleWant)), room - fixed - Math.round(room * 0.3)))
  const strip = Math.max(8, room - fixed - ws[1])
  const xs = []
  let x = 0
  for (const w of [...ws, strip]) {
    xs.push(x)
    x += w + 2
  }
  return { shown, ws, strip, xs }
}

// a title and its flags, gray (only Color by's choice takes a color), in `w` cells: the title whole, then whole flags
// parted by ` · `, ending ` · +N` for the N left out, or `+N` alone when none fits, the flags left out the words under
// the pointer; a title that fills the cells alone is cut, and its details give the flags
function titleRuns(it, w) {
  const f = it.flags
  const tw = width(it.title)
  if (!f.length || tw + 2 + width(plus(f.length)) > w) return [{ s: cut(it.title, w) }]
  let n = 0
  for (let i = 1; i <= f.length; i++) {
    if (tw + 2 + width(f.slice(0, i).join(' · ') + (i < f.length ? ` · ${plus(f.length - i)}` : '')) > w) break
    n = i
  }
  const words = [f.slice(0, n).join(' · '), n < f.length ? plus(f.length - n) : ''].filter(Boolean).join(' · ')
  return [{ s: it.title }, { s: '  ' }, { s: words, d: true, tip: n < f.length ? f.slice(n).join(' · ') : '' }]
}

// an item's records in the range as marks on the range's scale, each cell in the Color by hue most of its records
// take, over a line from its first to its last
function activity(it, scale) {
  const cells = new Map()
  for (const e of it.events) {
    if (!range.has(e[0]) || !colour.isOn(e[2])) continue
    const x = scale.x(e[0])
    const m = cells.get(x) || new Map()
    const v = e[2] === null || e[2] === undefined ? '' : String(e[2])
    m.set(v, (m.get(v) || 0) + 1)
    cells.set(x, m)
  }
  if (!cells.size) return []
  const a = Math.min(...cells.keys())
  const b = Math.max(...cells.keys())
  const out = []
  for (let x = 0; x <= b; x++) {
    const m = cells.get(x)
    if (!m) {
      out.push(x > a ? { s: '─', fg: COLORS.rule } : { s: ' ' })
      continue
    }
    let best = null
    let n = 0
    for (const [v, k] of m) if (v !== '' && k > n) [best, n] = [v, k]
    out.push(mark(best === null ? null : colour.colourOf(best)))
  }
  return out
}

// the activity's axis in the table's header: each run's name where it starts (or where the range does, in it), a click
// framing the run; then the ticks' times, dim, where they fit
function axisRow(r, x0, scale) {
  const put = []
  const taken = []
  const free = (x, w) => x >= 0 && x + w <= scale.cols && taken.every(([a, b]) => x + w + 1 <= a || x >= b + 1)
  for (const run of data.runs) {
    if (run.end < scale.from || run.start > scale.to) continue
    const x = scale.x(Math.max(run.start, scale.from))
    if (!free(x, width(run.run))) continue
    taken.push([x, x + width(run.run)])
    put.push({ x, s: run.run, style: {}, opts: { on: () => frameRun(run), tip: `${run.run}: ${when(run.start)} – ${when(run.end)}` } })
  }
  for (const tk of scale.ticks(10)) {
    if (!free(tk.x, width(tk.label))) continue
    taken.push([tk.x, tk.x + width(tk.label)])
    put.push({ x: tk.x, s: tk.label, style: { d: true } })
  }
  for (const p of put.sort((a, b) => a.x - b.x)) r.at(x0 + p.x).add(p.s, p.style, p.opts)
}

const actionOf = (x, own) => `${x.action}${x.number != null && String(x.number) !== own ? ` #${x.number}` : ''}`

// an item opened in place: what its row cut (the title, the flags), the same issue in every run, then its records in
// time order, each with its time, author, action, words and diff, and `↗` to its line
function detail(it, dd, L) {
  const u = units.get(it.key)
  if (!u) {
    dd.row().add('◌ reading its records', { d: true }).end()
    return
  }
  if (titleRuns(it, L.ws[1])[0].s !== it.title) for (const s of wrap(it.title, dd.cols)) dd.line(s)
  if (it.flags.length) for (const s of wrap(it.flags.join(' · '), dd.cols)) dd.line({ s, d: true })
  if (u.elsewhere && u.elsewhere.length) {
    const r = dd.row()
    u.elsewhere.forEach((x, i) => {
      if (i) r.gap()
      // the item's own issue is the one in view, so only the others open
      r.add(`${x.run} #${x.key.split('/')[2]} ${x.state}`, {}, x.key === it.key ? {} : { on: () => show(x.key), tip: 'open it in the list' })
    })
    r.end()
  }
  const own = it.key.split('/').at(-1)
  const recs = u.records
  const whoW = Math.min(10, Math.max(1, ...recs.map((x) => width(x.author || ''))))
  const actW = Math.min(22, Math.max(1, ...recs.map((x) => width(actionOf(x, own)))))
  const textX = 5 + 2 + whoW + 2 + actW + 2
  const textW = Math.max(10, dd.cols - textX - 3)
  for (const x of recs) {
    // the record a citation opened on the selection background, kept in view however far down it is
    const sel = x.ref === focus ? { bg: COLORS.selected } : {}
    if (x.ref === focus) dd.focus()
    const body = [x.sha, x.reason, x.text].filter(Boolean).join(' · ')
    const lines = body ? wrap(body, textW, 8) : []
    const r = dd.row()
    r.add(x.at.slice(11, 16), { d: true, ...sel }).gap()
    r.add(pad(cut(x.author || '', whoW), whoW), sel).gap()
    r.add(pad(cut(actionOf(x, own), actW), actW), { d: true, ...sel }).gap()
    if (lines.length) r.add(lines[0], sel)
    r.right('↗', { fg: COLORS.link }, { on: () => open(x.ref), tip: placeWords(x.ref) })
    r.end()
    for (const s of lines.slice(1)) dd.row().at(textX).add(s, sel).end()
    if (x.diff) for (const s of x.diff.replace(/\n$/, '').split('\n')) dd.row().at(textX).add(clip(s, dd.cols - textX), { d: true }).end()
  }
  details(dd, { ask: { ref: `view:${slug}/${it.key}`, text: it.title } })
}

draw((d) => {
  // the top row: the search, the kind of item, Color by with its chips, Reset at R
  colour.draw(d, (r) => {
    q.add(r).gap()
    kind.add(r).gap()
  })
  const name = KINDS.find((k) => k.value === kind.value).name
  if (!data) {
    d.row().add(`◌ reading the ${name}`, { d: true }).end()
    return
  }
  // the runs' activity over the whole span, with the window
  range.draw(d)
  d.blank()
  // the items active in the range that the search keeps; the columns from all the kind's items, so they hold still
  const words = q.text.trim().toLowerCase()
  const shown = data.items.filter((it) => (!words || it.search.includes(words)) && (range.full || it.events.some((e) => range.has(e[0]))))
  const L = layout(d.cols, data.items)
  const scale = range.scale(L.strip)
  rows.draw(d, {
    items: shown,
    colour,
    value: (it) => it.value,
    empty: `no ${name}`,
    header: (r) => {
      const x0 = r.x
      r.add('item', { d: true })
      ;[data.tab === 'agents' ? 'agent' : 'title', ...L.shown.map((c) => c.key)].forEach((n, i) => r.at(x0 + L.xs[1 + i]).add(n, { d: true }))
      axisRow(r, x0 + L.xs.at(-1), scale)
    },
    row: (it, r) => {
      const x0 = r.x
      r.add(idOf(it), { d: true })
      r.at(x0 + L.xs[1])
      for (const { s, tip, ...style } of titleRuns(it, L.ws[1])) r.add(s, style, tip ? { tip } : {})
      L.shown.forEach((c, i) => r.at(x0 + L.xs[2 + i]).add(cut(it[c.key] || '', L.ws[2 + i]), c.d ? { d: true } : {}))
      r.at(x0 + L.xs.at(-1)).runsOf(activity(it, scale))
    },
    onOpen: (it) => {
      focus = null
      readUnit(it.key)
    },
    ask: (it) => ({ ref: `view:${slug}/${it.key}`, text: it.title }),
    detail: (it, dd) => detail(it, dd, L),
  })
})

load()
