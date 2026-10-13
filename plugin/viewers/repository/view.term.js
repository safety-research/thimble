// Repository in the terminal: several agent runs on one small library, each run its own repository on a code forge,
// drawn the way the forge's command line draws one repository, as view.html does in the browser. The first row is the
// repository's head: the run switcher with the run's name (p, or a click, lists the runs with their tabs' counts) and
// the run's facts. The tabs row picks pull requests, issues, discussions or agents, each with its count. The top row
// searches, filters by any field or label and colors by state (or any field or label). The list has a row per item
// under the columns' names: its number, title and the tab's columns as the width holds them, and under it a dim line of
// what a forge writes there (who opened it when, the issue it fixes, its review decision, its flags; a thread's first
// words; an agent's sign-off). Enter opens the item's page in the side pane: a pull request's or an issue's timeline
// with each commit's diff, a thread's posts as replies under the first, an agent's sign-off and what it did; ↑↓ then
// move through its records and Enter opens a record's place. One fetch gives the run's items of the tab that the label
// filter and Filter by keep; the search narrows them here. Color marks the unit its value belongs to: a field
// colors the rows' marks and the track, an agent's under author by its own name; a label marks records, so a row, which
// stands for its records, shows their mix, as an agent's row does under a field of the items it worked on (state, area).
import { COLORS, choice, colorBy, columns, cut, dayName, details, draw, dur, fetch, filterBy, list, num, onLabels, onOpen, open as openPlace, plural, search, side, view, width, wrap } from 'thimble-term'

// the forge's tabs, with shorter names where the panel is narrow
const TABS = [
  { tab: 'pulls', name: 'pull requests', short: 'pulls' },
  { tab: 'issues', name: 'issues', short: 'issues' },
  { tab: 'discussions', name: 'discussions', short: 'threads' },
  { tab: 'agents', name: 'agents', short: 'agents' },
]
const TAB_OF = { pull: 'pulls', issues: 'issues', discussions: 'discussions', agents: 'agents' } // a key's second part
const slug = view().slug || 'repository'
const hm = (t) => new Date(t * 1000).toISOString().slice(11, 16)
const did = (it, k) => num(it.did[k] || 0)

// each tab's columns after the item's number: the name over it, what its cell says, its width and the panel width it
// shows from (`from` cells); the first is as wide as its longest cell where the panel has room. Only Color by colors,
// so an area is dim words.
const COLS = {
  pulls: [
    { name: 'pull request', cell: (it) => it.title },
    { name: 'area', w: 10, from: 84, cell: (it) => it.area || '', d: true },
    { name: 'state', w: 6, from: 60, cell: (it) => it.state },
    { name: 'comments', w: 8, from: 104, align: 'right', cell: (it) => num(it.comments) },
    { name: 'lines', w: 9, from: 96, align: 'right', cell: (it) => `+${it.plus} -${it.minus}` },
  ],
  issues: [
    { name: 'issue', cell: (it) => it.title },
    { name: 'area', w: 10, from: 84, cell: (it) => it.area || '', d: true },
    { name: 'state', w: 5, from: 60, cell: (it) => it.state },
    { name: 'fixed by', w: 8, from: 96, cell: (it) => it.prs.map((n) => `#${n}`).join(' ') },
    { name: 'comments', w: 8, from: 104, align: 'right', cell: (it) => num(it.comments) },
  ],
  discussions: [
    { name: 'thread', cell: (it) => it.title },
    { name: 'started by', w: 10, from: 84, cell: (it) => it.author },
    { name: 'posts', w: 5, from: 60, align: 'right', cell: (it) => num(it.posts) },
    { name: 'last post', w: 9, from: 96, cell: (it) => (it.last ? hm(it.last) : '') },
  ],
  agents: [
    { name: 'agent', cell: (it) => it.title },
    { name: 'pull requests', w: 13, from: 60, align: 'right', cell: (it) => did(it, 'pull requests') },
    { name: 'reviews', w: 7, from: 76, align: 'right', cell: (it) => did(it, 'reviews') },
    { name: 'merges', w: 6, from: 92, align: 'right', cell: (it) => did(it, 'merges') },
    { name: 'comments', w: 8, from: 104, align: 'right', cell: (it) => did(it, 'comments') },
  ],
}

// the dim line under an item's row: what a forge writes under a title, a thread's first words, an agent's sign-off
const META = {
  pulls: (it) => [`opened ${hm(it.opened)} by ${it.author}`, it.closes != null && `fixes #${it.closes}`, it.review,
    it.state === 'merged' && !it.flags.includes('merged by its author') && `merged by ${it.merged_by}`,
    it.state === 'closed' && `closed by ${it.closed_by}${it.reason ? ` as ${it.reason}` : ''}`, ...it.flags],
  issues: (it) => [`opened ${hm(it.opened)} by ${it.author}`, it.origin === 'backlog' ? 'from the backlog' : it.origin,
    it.state === 'fixed' && `fixed after ${dur(it.ended - it.opened)}`],
  discussions: (it) => [`${it.author}: "${it.lead}"`, it.posts > 1 && `${plural(it.posts - 1, 'reply', 'replies')}`],
  agents: (it) => [it.note ? `"${it.note}"` : 'left no transcript'],
}

let tab = 'pulls'
let run = null // the run whose repository shows, the reader's first until one is chosen
let data = null // the reader's answer for the run's tab (reader.py _view): {tab, run, items, counts, filtered, tabs, runs}
let loading = null // the newest load, which a citation waits for after it changed the tab
let want = null // a place a citation opened before the items arrived
const units = new Map() // an item's page (reader.py _detail), null while it is read

// the fields Filter by and Color by offer: each says what it is (view.json's records), and `meanings` what the states
// the forge gives mean (reader.py's notes), which the menus and a chip's tip show
const FIELDS = [
  {
    name: 'state', title: 'State', description: 'A pull request open, merged or closed by its records; an issue fixed once a pull request that fixes it merged',
    meanings: {
      open: 'A pull request neither merged nor closed, or an issue no merged pull request fixes yet', merged: 'A pull request merged',
      closed: 'A pull request closed without a merge', fixed: 'An issue that a merged pull request fixes',
    },
  },
  { name: 'area', title: 'Area', description: 'The part of the library: the first label, else the area of the issue it fixes' },
  { name: 'author', title: 'Author', description: 'Who opened the pull request or the issue, or started the thread' },
]
const color = colorBy({ fields: FIELDS, onChange: () => load() })
const filter = filterBy({ fields: FIELDS, onChange: () => load() })
const q = search({ words: 'search' })
// the run switcher, made once the reader named the runs: Reset puts back the run the view opens on
let runs = null
const facts = (r) => `${plural(r.team || 0, 'agent')} · ${plural(r.approvals || 1, 'approval')} to merge · ${dayName(r.start)}`
const tally = (r) => TABS.map((t) => `${num(r.tabs[t.tab])} ${t.short}`).join(' · ')
const rows = list({ key: (it) => it.key })
// an item's page beside the list, and its records in it, which ↑↓ move through while it is open
const pane = side({ key: 'item', width: 0.5 })
const recKey = (x) => `${x.ref} ${x.kind}` // a table's row holds a pull request's opening and its merge, on one ref
const records = list({ key: recKey, enter: 'to open its place' })
// the label filter or a label's values changed: fetch again, since the reader keeps only what the filter keeps
onLabels(() => load())

function load() {
  return (loading = reload())
}

async function reload() {
  let got
  try {
    got = await fetch({ op: 'view', run, tab, color: color.query(), filter: filter.query() }, { key: 'view' })
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  data = got
  run = got.run
  color.counts(got.counts)
  filter.counts(got.filtered)
  const values = got.runs.map((r) => ({ name: r.run, value: r.run, right: tally(r) }))
  if (!runs) runs = choice({ title: 'run', values, all: false, initial: got.run, key: 'p', tip: 'switch run', onChange: (r) => chooseRun(r) })
  else runs.values = values
  units.clear()
  if (pane.key !== null && !got.items.some((it) => it.key === pane.key)) pane.hide()
  if (pane.key !== null) await readUnit(pane.key)
  if (want) go()
}

async function readUnit(key) {
  if (units.get(key)) return
  units.set(key, null)
  try {
    units.set(key, await fetch({ op: 'unit', key }, { key: 'unit' }))
  } catch (e) {
    units.delete(key)
    if (e.name !== 'AbortError') throw e
  }
}

function choose(t) {
  if (t === tab) return
  tab = t
  pane.hide()
  load()
}

// another run's repository, on the same tab
function chooseRun(r) {
  if (!r || r === run) return
  run = r
  pane.hide()
  load()
}

// an item's page, on its tab, with the record `ref` chosen: a citation, a link and another run's issue come here
async function show(key, ref = null) {
  const t = TAB_OF[key.split('/')[1]]
  const r = key.split('/')[0]
  if (!t) return
  if (t !== tab || r !== run) {
    tab = t
    if (r !== run) {
      run = r
      if (runs) runs.set(r)
    }
    pane.hide()
    load()
    await loading
  }
  const it = data && data.items.find((i) => i.key === key)
  if (!it) return
  if (q.text && !it.search.includes(q.text.trim().toLowerCase())) q.set('')
  rows.choose(key)
  pane.show(key)
  await readUnit(key)
  const x = ref && units.get(key) && units.get(key).records.find((r) => r.ref === ref)
  if (x) records.choose(recKey(x))
}

// a run's citation opens its repository; any other opens its item
function go() {
  const t = want
  want = null
  if (t.run && data.runs.some((r) => r.run === t.run)) {
    if (runs) runs.set(t.run)
    chooseRun(t.run)
  } else if (t.key) show(t.key, t.ref)
}

onOpen((place) => {
  want = (place && place.target) || null
  if (want && data) go()
})

// ------------------------------------------------------------------------------------------------ an item's page

// a run of links on the rows they need, none split: [{words, key}]
function links(d, label, xs) {
  if (!xs.length) return
  let r = d.row().add(label, { d: true })
  for (const x of xs) {
    if (r.x + 2 + width(x.words) > d.cols) r = (r.end(), d.row().gap(width(label)))
    r.gap().add(x.words, {}, { on: () => show(x.key), tip: 'open its page' })
  }
  r.end()
}
const elsewhere = (u) => (u.elsewhere || []).filter((x) => x.run !== u.facts.run).map((x) => ({ words: `${x.run} #${x.key.split('/')[2]} ${x.state}`, key: x.key }))

// the rows over a page's records: its state and facts, named plainly, and the links to the items it names
const HEAD = {
  pulls: (u, d) => {
    const f = u.facts
    const end = f.state === 'merged' ? `${hm(f.ended)} by ${f.merged_by}, after ${dur(f.ended - f.opened)}` : f.state === 'closed' ? `${hm(f.ended)} by ${f.closed_by}${f.reason ? ` as ${f.reason}` : ''}` : null
    details(d, { facts: [['state', f.state], ['opened', `${hm(f.opened)} by ${f.author}`], [f.state, end], ['review', f.review],
      ['approvals', `${f.approvals} of ${f.need}`]] })
    if (u.fixes) links(d, 'fixes', [{ words: `#${u.fixes.number} ${cut(u.fixes.title, Math.max(12, d.cols - 12))}`, key: u.fixes.key }])
    links(d, 'other runs', elsewhere(u))
    if (f.flags.length) for (const s of wrap(f.flags.join(' · '), d.cols)) d.line({ s, d: true })
  },
  issues: (u, d) => {
    const f = u.facts
    details(d, { facts: [['state', f.state], ['opened', `${hm(f.opened)} by ${f.author}, ${f.origin === 'backlog' ? 'in the backlog' : f.origin}`],
      [f.state, f.ended ? `${hm(f.ended)}, after ${dur(f.ended - f.opened)}` : null]] })
    links(d, 'pull requests', (u.prs || []).map((p) => ({ words: `#${p.number} ${p.state}`, key: p.key })))
    links(d, 'other runs', elsewhere(u))
  },
  discussions: (u, d) => {
    const f = u.facts
    details(d, { facts: [['posts', num(f.posts)], ['people', num(f.posters.length)], ['from', `${hm(f.opened)} to ${hm(f.last)}`]] })
  },
  agents: (u, d) => {
    const f = u.facts
    details(d, { text: f.note ? `"${f.note}"` : 'left no transcript', facts: [['run', f.run], ...Object.entries(f.did).map(([k, n]) => [k, num(n)])] })
  },
}

// what a record did, as its row says it: a review by its verdict, a push with its commit, an item other than the page's
// by its number
function action(x, u) {
  if (x.kind === 'commit') return `${x.forced ? 'force-pushed' : 'pushed'} ${x.sha || ''}`
  if (x.kind === 'post') return 'posted'
  const other = x.number != null && x.number !== u.facts.number ? ` #${x.number}` : ''
  return `${x.kind === 'agent' ? 'signed off' : x.action}${other}`
}

// a record's row on the page: its time, author and what it did; a thread's posts as replies under the first, on guides
function recordRow(u, t) {
  const last = u.records.length - 1
  return (x, r) => {
    const i = u.records.indexOf(x)
    if (t === 'discussions' && i > 0) r.add(i === last ? '└ ' : '├ ', { fg: COLORS.rule })
    if (t === 'discussions') return r.add(x.author, { b: true }).gap().add(hm(Date.parse(x.at) / 1000), { d: true })
    r.add(hm(Date.parse(x.at) / 1000), { d: true }).gap()
    if (t !== 'agents') r.add(x.author).gap()
    r.add(action(x, u), { d: true })
  }
}

// a record's words under its row, a commit's diff as its lines are, at most eight rows until … N more is clicked
function recordBody(u, t) {
  const last = u.records.length - 1
  return (x, d) => {
    const i = u.records.indexOf(x)
    const guide = t !== 'discussions' ? '' : i === last ? '  ' : '│ '
    const text = x.kind === 'commit' ? (x.text || '').split('\n')[0] : t === 'agents' && x.title && x.kind !== 'post' ? x.title : x.text || ''
    for (const s of wrap(text, d.cols - width(guide), 6)) if (s) d.line(guide ? [{ s: guide, fg: COLORS.rule }, { s }] : s)
    if (x.diff) details(d, { blocks: [{ text: x.diff, max: 8 }] })
  }
}

// the page in the side pane: its head, then its records as a list of their own
function page(it, d) {
  const u = units.get(it.key)
  if (!u) {
    d.row().add('◌ reading its records', { d: true }).end()
    return
  }
  const t = TAB_OF[it.key.split('/')[1]]
  HEAD[t](u, d)
  d.blank()
  records.draw(d, {
    items: u.records,
    row: recordRow(u, t),
    body: recordBody(u, t),
    bodyIndent: t === 'discussions' ? 0 : 7,
    ask: (x) => ({ ref: x.ref, text: x.text || x.title || action(x, u) }),
    onOpen: (x) => {
      openPlace(x.ref)
      records.show(recKey(x), false)
    },
    empty: 'no records the label filter keeps',
  })
}

// ------------------------------------------------------------------------------------------------ the view

// a row that stands for its records (any under a label, an agent's under a field it does not carry) takes no mark of
// its own: the kit's color.mix of its records' values in `n` cells, where any of them takes a value
const MIX = 6
function mixCells(it, n = MIX) {
  const parts = it.mix || []
  const runs = parts.some(([v]) => v !== null) ? color.mix(Object.fromEntries(parts.map(([v, m]) => [v ?? '', m])), n) : []
  return runs.length ? runs : [{ s: ' '.repeat(n) }]
}

// the repository's head: the switcher with the run's name, then the run's facts in the room left
function headRow(d) {
  const r = d.row()
  runs.add(r)
  const now = data.runs.find((x) => x.run === run)
  if (now && r.room > 4) r.gap().add(cut(facts(now), r.room), { d: true })
  r.end()
}

// the tabs, each its name and count with a cell of space at each side, the chosen one inverse; 1-4 choose them
function tabsRow(d) {
  const counts = (t) => (data ? ` ${num(data.tabs[t.tab])}` : '')
  const long = TABS.reduce((n, t) => n + width(` ${t.name}${counts(t)} `) + 1, 0) <= d.cols
  const r = d.row()
  TABS.forEach((t, i) => {
    if (i) r.gap(1)
    r.add(` ${long ? t.name : t.short}${counts(t)} `, t.tab === tab ? { inv: true } : {}, { on: () => choose(t.tab), tip: `the ${t.name} (${i + 1})` })
  })
  r.end()
  d.key(['1', '2', '3', '4'], 'for the tabs', (k) => choose(TABS[Number(k) - 1].tab))
}

draw((d) => {
  if (data && runs) headRow(d)
  tabsRow(d)
  // the top row: the search, Filter by with its toggles, Color by with its chips, Reset at R
  color.draw(d, (r) => {
    q.add(r).gap()
    filter.add(r, { max: Math.max(20, Math.floor((d.cols - r.x) / 2)) }).gap()
  })
  const name = TABS.find((t) => t.tab === tab).name
  if (!data) {
    d.row().add(`◌ reading the ${name}`, { d: true }).end()
    return
  }
  d.blank()
  // the run's items that the search keeps
  const words = q.text.trim().toLowerCase()
  const items = data.items.filter((it) => !words || it.search.includes(words))
  // a field colors the rows' marks and the track; a label, whose marks are on records, colors neither: the rows show
  // their records' mix and the track is plain, as the agents' rows do under a field they do not carry
  const group = !!color.label || data.items.some((it) => it.mix)
  // the columns the list's width holds after the item's number, laid out as its header draws, in the width the side pane
  // leaves it less the mark and the track
  const idW = tab === 'pulls' || tab === 'issues' ? Math.max(3, ...data.items.map((it) => width(`#${it.number}`))) : 0
  let specs = []
  let C = null
  const mixW = group ? MIX + 2 : 0
  rows.draw(d, {
    items,
    ...(group ? {} : { color, value: (it) => it.value }),
    empty: `no ${name}`,
    header: (r) => {
      const room = r.d.cols - 5 - (idW ? idW + 2 : 0) - mixW + (group ? 2 : 0)
      if (group) r.add(' '.repeat(MIX)).gap()
      specs = COLS[tab].filter((c) => !c.from || room + 5 >= c.from)
      // the first column as wide as its longest cell where the panel has room to spare, so the others stand by it
      const rest = specs.slice(1).reduce((n, c) => n + c.w + 2, 0)
      const first = Math.max(12, Math.min(room - rest, Math.max(width(specs[0].name), ...data.items.map((it) => width(specs[0].cell(it))))))
      C = columns(specs.map((c, i) => (i ? { w: c.w, align: c.align } : { w: first })), room)
      if (idW) r.add(' '.repeat(idW)).gap()
      C.header(r, specs.map((c) => c.name))
    },
    row: (it, r) => {
      if (group) r.runsOf(mixCells(it)).gap()
      if (idW) r.add(`#${it.number}`.padEnd(idW), { d: true }).gap()
      C.cells(r, specs.map((c) => cut(c.cell(it), C.widths[specs.indexOf(c)])), specs.map((c) => (c.d ? { d: true } : {})))
    },
    body: (it, bd) => bd.line({ s: cut(META[tab](it).filter(Boolean).join(' · '), bd.cols), d: true }),
    bodyIndent: (group ? mixW : 2) + (idW ? idW + 2 : 0),
    side: pane,
    sideTitle: (it) => `${it.run}${it.number != null ? ` #${it.number}` : ''} ${it.title}`,
    detail: page,
    onOpen: (it) => readUnit(it.key),
    ask: (it) => ({ ref: `view:${slug}/${it.key}`, text: it.title }),
  })
})

load()
