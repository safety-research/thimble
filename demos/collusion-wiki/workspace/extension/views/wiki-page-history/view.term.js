// Wiki Page History in the terminal, as view.html draws it in the browser. The top row searches the pages by name and
// holds Filter by and Color by over the same fields: a revision's wiki, its kind of save, its page's status, its kind
// of message, its signature, or any label; Filter by hides the records of a value turned off, Color by keeps them,
// dim. The time range's strip picks the time the chart, the list and the history show; under it the range's
// revisions per cell in the Color by hues, and its deletes. The list holds the pages in the range, the most revisions
// first, each with the mix of its revisions' colors (a page is a group, so it takes no color of its own, and the list
// has a plain track), its counts and its revisions over the range. A page opens in the side pane: its revisions over
// time, the lines they added and removed, and its history in the range read as messages (the text each save added) on
// a page used as a message thread, or as diffs, `m` switching; a revision opens in place with its text or its diff and
// its place. One fetch gives every page and revision the label filter keeps; a page's history comes when it opens, its
// items in full as they come into view.
import {
  COLORS, axis, bar, colorBy, columns, cut, dayName, dayOf, details, divider, draw, fetch, filterBy, hms, list, merged, num,
  onLabels, onOpen, onReset, pad, plural, redraw, search, side, strip, timeRange, width,
} from 'thimble-term'

const G = 14 // the gutter that names the chart's rows, which the strip and the axis leave too
const SPARK = 12 // cells of a page's revisions over the range in its row
const MIX = 6 // cells of a page's mix of colors
const CHUNK = 30 // history items read in full at a time
const BASE_NAME = ['New page', 'Edit', 'After a delete', 'First stored'] // the reader's BASES: new, prev, deleted, withheld
const STATUS = ['deleted', 'never deleted']
const KIND_NAME = [null, 'Text only', 'With links'] // the reader's KINDS
const SIGNED = ['Own username', 'Another name', 'Unsigned'] // the reader's SIGNED
const FIELDS = [
  { name: 'wiki', title: 'Wiki', description: 'The wiki the page belongs to', values: ['dse', 'probier', 'fractal', 'dorfwiki'] },
  {
    name: 'save', title: 'Kind of save', description: "What the revision's diff is against", values: BASE_NAME,
    meanings: {
      'New page': "The page's first revision, compared with an empty page", Edit: 'Compared with the revision before',
      'After a delete': 'The first revision after a delete of the page, compared with an empty page',
      'First stored': "The page's first revision in the corpus, after earlier ones the corpus does not hold",
    },
  },
  {
    name: 'status', title: 'Status', description: 'Whether a delete event names the page', values: STATUS,
    meanings: { deleted: 'At least one delete event in events.jsonl names the page', 'never deleted': 'No delete event names the page' },
  },
  {
    name: 'kind', title: 'Kind of message', values: KIND_NAME.slice(1),
    description: 'What the text a revision added holds, once blanks, the stock new-page line and withheld placeholders are dropped; a revision that adds none takes no kind',
    meanings: { 'Text only': 'The text the revision added holds no link', 'With links': 'The text the revision added holds http://, https:// or www.' },
  },
  {
    name: 'signed', title: 'Signature', values: SIGNED,
    description: "Whether the text a revision added ends in a signature (-- name), and whether that name is the revision's username",
    meanings: {
      'Own username': "The text ends in a signature that is the revision's username, ignoring case",
      'Another name': "The text ends in a signature that is not the revision's username", Unsigned: 'The text ends in no signature',
    },
  },
]
const PAGE_FIELDS = new Set(['wiki', 'status']) // the page's own fields, which Filter by hides its row by

// ---------------------------------------------------------------- state
let O = null // the reader's overview
let PAGES = [] // a page per row of the overview: {r, p, name, wiki, status, n, u, d, key, revs: [rev], dels: [del]}
let REVS = [] // every revision: {r, t, wiki, save, status, kind, signed, mb, value}
let DELS = [] // every delete of a listed page: {r, t, wiki, status, mb, value}
let GONE = [] // the deletes of pages with no stored revision: {t, wiki, name, value}
let loaded = false
let seq = 0
let PG = null // the open page's history: the reader's answer
let pageSeq = 0
const got = new Map() // a history item's key -> the item read in full
const histRows = new Map() // an item's row as drawn, by what it depends on
const asked = new Set()
let readMode = null // 'messages' or 'diff' when the analyst chose, else the page's own way
const S = { item: null } // the history item a citation opened

const filter = filterBy({ fields: FIELDS, onChange: () => assign() })
const colour = colorBy({ fields: FIELDS, onChange: () => assign() })
const q = search({ words: 'search pages', onChange: () => redraw() })
const range = timeRange({ onChange: () => {} })
const pane = side({ key: 'page', width: 0.56 })
const div = divider({ key: 'overview' })
const pageList = list({ key: (pg) => pg.p })
const hist = list({ key: (it) => it.key, enter: 'to read it' })
onReset({ changed: () => readMode !== null, reset: () => { readMode = null } })
onLabels(() => load())

// ---------------------------------------------------------------- the overview
// The pages come PART at a time, and while they or a page's history load, the words that say so change every TICK ms,
// so the view's frames show it reads them.
const PART = 600
const TICK = 120
let ticks = 0, ticker = null, waits = 0, partsGot = 0
function waiting(on) {
  waits = Math.max(0, waits + (on ? 1 : -1))
  if (waits && !ticker) ticker = setInterval(() => { ticks++; redraw() }, TICK)
  if (!waits && ticker) { clearInterval(ticker); ticker = null }
}
const dots = () => '.'.repeat(ticks % 4)
const PIECE = 4000 // revisions made into records between two frames
// a frame drawn before the work goes on
const yieldFrame = () => {
  ticks++
  redraw()
  return new Promise((ok) => setTimeout(ok, 0))
}
let markLoaded
const ready = new Promise((ok) => (markLoaded = ok))
const COLS = { pages: ['p', 'ln', 'w', 'name', 'n', 'f', 'l', 'u', 'd', 'pm', 'pb'], revs: ['rp', 'rt', 'ru', 'rk', 'rg', 'rs', 'rb'], dels: ['dp', 'dt', 'db'] }
async function load() {
  const my = ++seq
  let res = null
  waiting(true)
  partsGot = 0
  try {
    let from = 0
    do {
      const part = await fetch({ op: 'overview', from, n: PART }, { key: 'overview' })
      if (my !== seq) return
      if (!res) res = part
      else {
        for (const [g, ks] of Object.entries(COLS)) for (const k of ks) res[g][k].push(...part[g][k])
        res.keys.push(...part.keys)
      }
      partsGot++
      await yieldFrame()
      if (my !== seq) return
      from = part.next
    } while (from != null)
    // the records made from the columns, a frame drawn between pieces of them, so the view shows it still reads
    const o = res
    const P = o.pages
    // each page's counts written out once, since its row draws them in every frame
    const pages = P.p.map((p, r) => ({
      r, p, name: P.name[r], wiki: o.wikis[P.w[r]], status: P.d[r] ? STATUS[0] : STATUS[1], n: P.n[r], u: P.u[r], d: P.d[r], key: o.keys[r], pb: P.pb[r],
      nTxt: num(P.n[r]), uTxt: num(P.u[r]), dTxt: P.d[r] ? num(P.d[r]) : '', revs: [], dels: [],
    }))
    const at = new Map(pages.map((pg) => [pg.p, pg]))
    const revs = []
    for (let k = 0; k < o.revs.rp.length; k++) {
      if (k && k % PIECE === 0) { await yieldFrame(); if (my !== seq) return }
      const pg = at.get(o.revs.rp[k])
      const rv = { r: pg.r, t: o.t0 + o.revs.rt[k], wiki: pg.wiki, save: BASE_NAME[o.revs.rk[k]], status: pg.status, kind: KIND_NAME[o.revs.rg[k]], signed: o.revs.rs[k] >= 0 ? SIGNED[o.revs.rs[k]] : null, mb: o.revs.rb[k] }
      pg.revs.push(rv)
      revs.push(rv)
    }
    DELS = o.dels.dp.map((p, k) => {
      const pg = at.get(p)
      const dl = { r: pg.r, t: o.t0 + o.dels.dt[k], wiki: pg.wiki, status: pg.status, mb: o.dels.db[k] }
      pg.dels.push(dl)
      return dl
    })
    GONE = o.gone.ot.map((t, k) => ({ t: o.t0 + t, wiki: o.wikis[o.gone.ow[k]], status: STATUS[0], name: o.gone.on[k], mb: 0 }))
    O = o
    PAGES = pages
    REVS = revs
    loaded = true
    assign()
    await yieldFrame()
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  } finally {
    waiting(false)
  }
  if (my !== seq) return
  markLoaded()
  if (PG) openPage(PG.page.p, null, true)
}

// a control's label's value among a record's marks, given as bits of indices into `marks`
function labelOf(bits, marks, ctl = colour) {
  const by = ctl.by
  if (!by || !by.label || !bits || !marks) return null
  for (let j = 0; j < marks.length; j++) if (bits & (1 << j) && marks[j].label === by.title) return marks[j].value
  return null
}
// each record's value under a label (the kit reads a field's from the record itself), the chips' counts, the range
function assign() {
  if (!O) return
  labelsV++
  const lab = !!colour.label
  for (const x of REVS) { if (lab) x.value = labelOf(x.mb, O.marks); else delete x.value }
  for (const x of DELS) { if (lab) x.value = labelOf(x.mb, O.marks); else delete x.value }
  for (const pg of PAGES) { if (lab) pg.value = labelOf(pg.pb, O.marks); else delete pg.value }
  if (PG) for (const it of PG.items) { if (lab) it.value = labelOf(it.mb, PG.marks); else delete it.value }
  feedRange()
  redraw()
}
// whether Filter by keeps a page (or a delete of a page with no stored revision): by its own wiki or status; always
// under the other fields and the labels, which its records take
const pageKeeps = (pg) => !filter.field || !PAGE_FIELDS.has(filter.field) || filter.isOn(pg[filter.field])
// a record's value under Filter by: a label's from its marks (`marks` the overview's or the open page's), else its
// field's
const filterValue = (x, marks = O.marks) => (filter.label ? labelOf(x.mb, marks, filter) : filter.field ? x[filter.field] ?? null : null)
// whether Filter by keeps a revision
const revKept = (x, marks) => filter.isOn(filterValue(x, marks))
const named = (pg) => { const t = q.text.trim().toLowerCase(); return !t || pg.name.toLowerCase().includes(t) }
const deleteValue = (x) => (colour.label ? x.value ?? null : PAGE_FIELDS.has(colour.field) ? x[colour.field] : null)
function feedRange() {
  const times = [], values = []
  for (const pg of PAGES) {
    if (!pageKeeps(pg)) continue
    for (const x of pg.revs) if (revKept(x)) { times.push(x.t); values.push(colour.valueOf(x)) }
    for (const x of pg.dels) { times.push(x.t); values.push(deleteValue(x)) }
  }
  for (const x of GONE) if (pageKeeps(x)) { times.push(x.t); values.push(PAGE_FIELDS.has(colour.field) ? x[colour.field] : null) }
  range.data({ times, values, span: [O.t0 + O.span[0], O.t0 + O.span[1]] })
}
// What a frame draws of the pages, worked out again only when what it depends on changes (the range, the colour, the
// search, the labels' values, the page open): the pages shown, and each page's mix and revisions over the range.
let memo = { sig: null, pages: [], keptRevs: [], keptDels: [], mix: new Map(), spark: new Map(), strips: null, rows: new Map() }
let labelsV = 0
function pagesNow() {
  const sig = JSON.stringify([range.from, range.to, colour.query(), colour.off, colour.values.filter((v) => !v.on).map((v) => v.value), filter.query(), q.text, pane.key, labelsV, loaded])
  if (memo.sig === sig) return memo.pages
  const pages = shownPages()
  // the chart's records and the two controls' counts: Filter by's over the revisions in the range of the pages the
  // search keeps, a value turned off counted too; Color by's over those Filter by keeps of the pages shown, which are
  // the chart's; their deletes, and those of pages with no stored revision where the search and Filter by keep them
  const keptRevs = [], keptDels = [], counts = {}, fcounts = {}
  for (const pg of PAGES) {
    if (!named(pg)) continue
    for (const x of pg.revs) if (range.has(x.t)) { const v = filterValue(x); fcounts[v ?? ''] = (fcounts[v ?? ''] || 0) + 1 }
  }
  for (const pg of pages) {
    for (const x of pg.revs) {
      if (!range.has(x.t) || !revKept(x)) continue
      const v = colour.valueOf(x)
      counts[v ?? ''] = (counts[v ?? ''] || 0) + 1
      keptRevs.push(x)
    }
    for (const x of pg.dels) if (range.has(x.t)) keptDels.push(x)
  }
  const t = q.text.trim().toLowerCase()
  for (const x of GONE) if (range.has(x.t) && (!t || x.name.toLowerCase().includes(t)) && pageKeeps(x)) keptDels.push(x)
  memo = { sig, pages, keptRevs, keptDels, mix: new Map(), spark: new Map(), strips: null, rows: new Map() }
  filter.counts(fcounts)
  colour.counts(counts)
  return pages
}
function mixOf(pg) {
  let m = memo.mix.get(pg.p)
  if (!m) memo.mix.set(pg.p, (m = mixRuns(pg)))
  return m
}
function sparkOf(pg, scale) {
  let m = memo.spark.get(pg.p)
  if (!m) memo.spark.set(pg.p, (m = strip(scale, pg.revs.filter((x) => range.has(x.t) && revKept(x)), { value: (x) => colour.valueOf(x), colour })))
  return m
}
// the pages in the range that the search and Filter by keep, the most revisions first
function shownPages() {
  const out = []
  for (const pg of PAGES) {
    if (!pageKeeps(pg) || !named(pg)) continue
    let n = 0, d = 0
    for (const x of pg.revs) if (range.has(x.t)) n++
    for (const x of pg.dels) if (range.has(x.t)) d++
    if (n || d || pg.p === pane.key) out.push(pg)
  }
  return out.sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1))
}
// a page's mix of its revisions' colors in the range, in MIX cells: the kit's colour.mix of the values of its records
// that Filter by keeps (a delete and the page's line under a label it holds by their value of it), a value turned off
// dim; blank with Color by Off or no record
function mixRuns(pg) {
  const n = {}
  const add = (v) => { const k = v ?? ''; n[k] = (n[k] || 0) + 1 }
  const kept = (bits) => !filter.label || filter.isOn(labelOf(bits, O.marks, filter))
  for (const x of pg.revs) if (range.has(x.t) && revKept(x)) add(colour.valueOf(x))
  for (const x of pg.dels) if (range.has(x.t) && kept(x.mb)) add(deleteValue(x))
  if (colour.label && pg.value != null && kept(pg.pb)) add(pg.value)
  const runs = colour.mix(n, MIX)
  return runs.length ? runs : [{ s: ' '.repeat(MIX) }]
}

// ---------------------------------------------------------------- the open page
async function openPage(p, focus, again) {
  const my = ++pageSeq
  if (!again) { got.clear(); asked.clear(); histRows.clear(); readMode = PG && PG.page.p === p ? readMode : null }
  let res
  waiting(true)
  try {
    res = await fetch({ op: 'page', p, n: 1, ...(focus ? { focus } : {}) }, { key: 'page' })
    // the pages first, whose times and usernames the history's items read
    await ready
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  } finally {
    waiting(false)
  }
  if (my !== pageSeq || !res) return
  const st = res.strip
  res.items = st.k.map((k, i) => ({
    key: `${k}${st.x[i]}`, k, x: st.x[i], t: O.t0 + st.t[i], u: st.u[i] >= 0 ? O.users[st.u[i]] : null, a: st.a[i], rm: st.r[i], seq: st.s[i],
    mb: st.b[i], wiki: res.page.wiki, status: res.page.deletes ? STATUS[0] : STATUS[1], save: k === 'r' ? BASE_NAME[st.kb[i]] : null,
    kind: k === 'r' ? KIND_NAME[st.g[i]] : null, signed: k === 'r' && st.sg[i] >= 0 ? SIGNED[st.sg[i]] : null,
    ref: `${k === 'r' ? res.files.revisions : res.files.events}#L${st.ln[i]}`,
  }))
  PG = res
  for (const b of res.blocks || []) got.set(b.kind === 'delete' ? `d${b.x}` : b.kind === 'request' ? `q${b.x}` : `r${b.i}`, b)
  assign()
}
const mode = () => readMode || (PG && PG.page.thread ? 'messages' : 'diff')
// the open page's items the pane lists: in the range, kept by Filter by (an event takes a field's no value and shows)
function listedItems() {
  if (!PG) return []
  return PG.items.filter((it) => range.has(it.t) && (it.k === 'r' ? revKept(it, PG.marks) : !filter.label || filter.isOn(filterValue(it, PG.marks))))
}
// the items in view not read yet, read CHUNK at a time
let reading = false
async function readShown() {
  if (reading || !PG) return
  const todo = hist.shown.filter((it) => it.key && !got.has(it.key) && !asked.has(it.key)).slice(0, CHUNK)
  if (!todo.length) return
  reading = true
  const my = pageSeq
  for (const it of todo) asked.add(it.key)
  try {
    const res = await fetch({ op: 'page', p: PG.page.p, items: todo.map((it) => [it.k, it.x]) }, { key: 'items' })
    if (my !== pageSeq) return
    for (const b of res.blocks || []) got.set(b.kind === 'delete' ? `d${b.x}` : b.kind === 'request' ? `q${b.x}` : `r${b.i}`, b)
  } catch (e) {
    for (const it of todo) asked.delete(it.key)
    if (e.name !== 'AbortError') throw e
  } finally {
    reading = false
  }
  redraw()
}
// an item's words in its row: a message's first line, or a diff's summary or first added line
function itemWords(it) {
  if (it.k === 'd') return `deleted${it.u ? ` by ${it.u}` : ''}`
  const b = got.get(it.key)
  if (it.k === 'q') return b ? `request ${b.request_action || ''} ${b.request || ''}`.trim() : 'request'
  if (!b) return '…'
  if (mode() === 'messages') return (b.message || '').split('\n').find((s) => s.trim()) || (b.rem ? `removed ${plural(b.rem, 'line')}, no new text` : 'no new text')
  return b.change_summary || ((b.diff || []).find((l) => l[0] === '+' && String(l[1]).trim()) || [])[1] || 'no line changed'
}
// a revision's diff as text, its lines signed, a run of unchanged lines folded
function diffText(b) {
  return (b.diff || []).map((l) => (l[0] === '~' ? `  … ${plural(l[1], 'unchanged line')}` : `${l[0] === '+' ? '+' : l[0] === '-' ? '−' : ' '} ${l[1]}`)).join('\n')
}
// the open page over time on the range's scale: its revisions in the Color by hues, its deletes, and the lines its
// revisions added and removed per cell, in a diff's green and red
function pageChart(dd, items) {
  const gut = 8
  const scale = range.scale(Math.max(8, dd.cols - gut))
  const revs = items.filter((it) => it.k === 'r'), dels = items.filter((it) => it.k === 'd')
  const sums = (key, fg) => {
    const n = new Array(scale.cols).fill(0)
    for (const it of revs) { const x = scale.binOf(it.t); if (x >= 0) n[x] += it[key] }
    const max = Math.max(1, ...n)
    return n.map((k) => ({ s: bar(k, max), fg }))
  }
  const row = (name, runs) => dd.row().add(name.padEnd(gut), { d: true }).runsOf(runs).end()
  row('saves', strip(scale, revs, { value: (it) => colour.valueOf(it), colour }))
  if (dels.length) row('deletes', strip(scale, dels))
  row('+ lines', sums('a', COLORS.added))
  row('− lines', sums('rm', COLORS.removed))
}

// ---------------------------------------------------------------- places
// a page opens in the pane, a revision, delete or request in its page's history, open in place; a username searches
// nothing here (the browser's username filter), an event no page holds shows nothing more
onOpen(async (place) => {
  const t = (place && place.target) || {}
  // the words that say the view reads keep changing until the place is open
  waiting(true)
  try {
    await opening(t)
  } finally {
    waiting(false)
  }
})
async function opening(t) {
  if (t.p == null || t.p < 0) return
  // the page's history asked for at once, beside the pages
  const focus = t.rev != null ? { rev: t.rev } : t.del != null ? { del: t.del } : t.req != null ? { req: t.req } : null
  const asking = openPage(t.p, focus)
  await ready
  const pg = PAGES.find((x) => x.p === t.p)
  if (pg && !named(pg)) q.set('')
  if (pg) pageList.choose(pg.p)
  pane.show(t.p)
  await asking
  const key = t.rev != null ? `r${t.rev}` : t.del != null ? `d${t.del}` : t.req != null ? `q${t.req}` : null
  const it = key && PG ? PG.items.find((x) => x.key === key) : null
  if (it) {
    if (!range.has(it.t)) range.set(null)
    hist.show(key)
  }
}

// ---------------------------------------------------------------- the drawing
draw((d) => {
  // while a page or a place opens, the subtitle says so, its dots moving, so the frames show the view still reads
  if (loaded && waits) d.sub(`◌ reading${dots()}`)
  // the top row: the search, Filter by and Color by with its chips, Reset at R; in a narrow panel the search on a row
  // of its own, Filter by on the next
  if (d.cols < 80) {
    q.add(d.row()).end()
    filter.add(d.row(), { max: d.cols }).end()
    colour.draw(d)
  } else colour.draw(d, (r) => { q.add(r).gap(); filter.add(r, { max: Math.max(14, Math.floor(d.cols * 0.32)) }).gap() })
  if (!loaded) {
    d.row().add(`◌ reading the pages${partsGot ? ` · ${num(Math.min(partsGot * PART, 1e9))}` : ''}${dots()}`, { d: true }).end()
    return
  }
  const pages = pagesNow()
  // the overview, in the rows the divider gives it: the readout and the strip, the range's revisions and deletes, the axis
  const n = div.rows(d, Math.min(6, Math.max(5, Math.floor(d.left / 3))))
  range.draw(d, { gutter: G })
  const scale = range.scale(d.cols - G)
  const { keptRevs, keptDels } = memo
  if (!memo.strips || memo.strips.cols !== scale.cols) memo.strips = { cols: scale.cols, revs: strip(scale, keptRevs, { value: (x) => colour.valueOf(x), colour }), dels: strip(scale, keptDels) }
  d.row().add(cut(`${num(keptRevs.length)} saves`, G - 1).padEnd(G), { d: true }).runsOf(memo.strips.revs).end()
  if (n > 4) d.row().add(cut(`${num(keptDels.length)} deletes`, G - 1).padEnd(G), { d: true }).runsOf(memo.strips.dels).end()
  axis(d, scale, { gutter: G })
  d.blank()
  // the pages, each with its mix, its counts and its revisions over the range; the open page's history in the pane
  const wide = !pane.isOpen && d.cols >= 70
  const specs = wide
    ? [{ grow: true, min: 10 }, { w: MIX }, { w: 6, align: 'right' }, { w: 5, align: 'right' }, { w: 4, align: 'right' }, { w: SPARK }]
    : [{ grow: true, min: 8 }, { w: MIX }, { w: 6, align: 'right' }]
  const cols = columns(specs, d.cols - 3)
  const sparkScale = range.scale(SPARK)
  pageList.draw(d, {
    title: 'Pages',
    count: plural(pages.length, 'page'),
    items: pages,
    // a page is a group: no mark of its own, and the list's track is plain
    value: () => null,
    mark: false,
    empty: 'no page meets these filters in this range',
    header: pane.isOpen ? null : (r) => cols.header(r, wide ? ['page', '', 'saves', 'names', 'del', ''] : ['page', '', 'saves']),
    // a page's row is the same from frame to frame until what it shows changes, so its runs are kept (memo.rows)
    row: (pg, r) => {
      const key = `${pg.p}:${r.room}:${pane.isOpen ? 1 : 0}`
      let runs = memo.rows.get(key)
      if (!runs) memo.rows.set(key, (runs = merged(rowRuns(pg, r.room, cols, wide, sparkScale))))
      r.runsOf(runs)
    },
    side: pane,
    sideTitle: (pg) => pg.name,
    onOpen: (pg) => openPage(pg.p),
    ask: (pg) => (pg.key ? { ref: `view:wiki-page-history/${pg.key}`, text: pg.name } : null),
    detail: (pg, dd) => drawPage(pg, dd),
  })
})

// a page's row in `room` cells: its name and wiki, its mix and its revisions; beside the open pane that alone, else
// its usernames, deletes and its revisions over the range too where the list is wide
function rowRuns(pg, room, cols, wide, sparkScale) {
  const out = []
  const add = (s, st = {}) => out.push({ s: String(s), ...st })
  if (pane.isOpen) {
    const n = pg.nTxt
    const nm = cut(pg.name, Math.max(4, room - MIX - 3 - pg.wiki.length - n.length))
    add(nm); add(' '); add(pg.wiki, { d: true }); add(' ')
    out.push(...mixOf(pg))
    add(' '.repeat(Math.max(1, room - width(nm) - pg.wiki.length - MIX - 2 - n.length)))
    add(n, { d: true })
    return out
  }
  const w = cols.widths
  // the name, and its wiki dim after it, since names repeat across the wikis
  const nm = cut(pg.name, Math.max(4, w[0] - pg.wiki.length - 1))
  add(nm); add(' '); add(pad(pg.wiki, w[0] - width(nm) - 1), { d: true }); add('  ')
  out.push(...mixOf(pg))
  add('  '); add(pg.nTxt.padStart(w[2]), { d: true })
  if (wide) {
    add('  '); add(pg.uTxt.padStart(w[3]), { d: true }); add('  '); add(pg.dTxt.padStart(w[4]), { d: true }); add('  ')
    out.push(...sparkOf(pg, sparkScale))
  }
  return out
}

// the open page in the pane: its facts and how it reads, its chart, its history
function drawPage(pg, dd) {
  if (!PG || PG.page.p !== pg.p) {
    dd.row().add(`◌ reading the page${dots()}`, { d: true }).end()
    return
  }
  const g = PG.page
  const top = dd.row()
  top.add(`${g.wiki} · ${plural(g.n_revs, 'revision')} · ${plural(PG.users.length, 'username')}`, { d: true })
  top.end()
  // how the revisions read: as messages or as diffs, the one in use on the selection background; `m` switches
  const m = mode()
  const rr = dd.row()
  rr.add('read as', { d: true }).gap()
  const set = (v) => { readMode = v === (PG.page.thread ? 'messages' : 'diff') ? null : v; redraw() }
  for (const v of ['messages', 'diff']) {
    rr.add(v, m === v ? { bg: COLORS.selected } : {}, { on: () => set(v), tip: v === 'messages' ? 'each revision as the text it added' : 'each revision as its diff against the one before' })
    rr.gap()
  }
  rr.end()
  dd.key('m', m === 'messages' ? 'to read diffs' : 'to read messages', () => set(m === 'messages' ? 'diff' : 'messages'))
  const items = listedItems()
  pageChart(dd, items)
  // the history in the range, a heading for each day
  const rows = []
  let day = ''
  for (const it of items) {
    if (dayOf(it.t) !== day) rows.push({ heading: dayName(((day = dayOf(it.t)), it.t)), key: null })
    rows.push(it)
  }
  hist.draw(dd, {
    items: rows,
    colour,
    value: (it) => (it.k === 'r' ? colour.valueOf(it) : colour.label ? it.value ?? null : null),
    empty: 'no revision of this page meets these filters',
    // an item's row is kept from frame to frame until it is read in full or reads otherwise (histRows)
    row: (it, r) => {
      const key = `${it.key}:${r.room}:${m}:${got.has(it.key) ? 1 : 0}:${dd.cols}`
      let runs = histRows.get(key)
      if (!runs) {
        runs = []
        runs.push({ s: hms(it.t), d: true }, { s: ' ' })
        let room = r.room - 9
        if (it.k === 'r') {
          const u = cut(it.u || 'anonymous', 16)
          runs.push(it.u ? { s: u } : { s: u, d: true, i: true }, { s: ' ' })
          room -= width(u) + 1
          if (dd.cols >= 44) { const st = `+${num(it.a)} −${num(it.rm)}`; runs.push({ s: st, d: true }, { s: ' ' }); room -= width(st) + 1 }
        }
        runs.push(it.k === 'r' ? { s: cut(itemWords(it), Math.max(4, room)) } : { s: cut(itemWords(it), Math.max(4, room)), d: true })
        if (histRows.size > 20000) histRows.clear()
        histRows.set(key, (runs = merged(runs)))
      }
      r.runsOf(runs)
    },
    detail: (it, ed) => drawItem(it, ed),
    ask: (it) => ({ ref: it.ref, text: itemWords(it) }),
  })
  readShown()
}

// a history item in place under its row: a revision's message or diff, its facts and its place; an event's facts
function drawItem(it, ed) {
  const b = got.get(it.key)
  if (!b) {
    ed.row().add('◌ reading it', { d: true }).end()
    return
  }
  if (it.k === 'r') {
    const facts = [['seq', b.seq], ['by', b.label || 'anonymous'], ['ip', b.ip16 ? `${b.ip16}.*.*` : ''], ['summary', b.change_summary], ['save', it.save], ['signed', b.signature]]
    if (mode() === 'messages') details(ed, { blocks: [{ text: b.message || (b.rem ? `removed ${plural(b.rem, 'line')} and added no new text` : 'no new text'), max: 12 }], facts, place: b.ref })
    else details(ed, { blocks: [{ text: diffText(b) || 'no line changed', max: 16 }], facts: [...facts, ['lines', `+${num(b.add)} −${num(b.rem)}`]], place: b.ref })
    return
  }
  const facts = it.k === 'd' ? [['by', b.actor_label], ['ip', b.ip16 ? `${b.ip16}.*.*` : ''], ['summary', b.change_summary]] : [['by', b.label], ['action', b.request_action], ['ip', b.ip16 ? `${b.ip16}.*.*` : '']]
  details(ed, { text: it.k === 'q' ? b.request : '', facts, place: b.ref })
}

load()
