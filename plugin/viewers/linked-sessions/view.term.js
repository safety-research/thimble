// Linked sessions in the terminal: a reader for many related agent transcripts, as view.html draws it in the browser.
// The top row searches the turns, filters them (Filter by), groups the lanes (Rows) and colors them (Color by); the time
// range's strip, broken where the runs lie hours apart, picks the time the lanes and the transcript show. A lane per
// session, each subagent under the session that started it with its tree guide, shows its turns in the Color by hues
// and a failed call as a red ×; a click on a lane's name reads that session. Under the lanes, what links the session
// read to the others (the session that started it, when its result came back, the subagents it started), then its
// transcript, a turn's whole words and a call's input and output opening in the side pane. One fetch gives what the
// search and the controls keep; a session's turns come when it is read, a call's whole input when it opens.
import { axis, colorBy, divider, draw, fetch, filterBy, hms, lanes, onLabels, onOpen, plural, rows, search, side, timeRange, transcript, width, COLORS } from 'thimble-term'

const KIND = { prompt: 'prompt', text: 'text', result: 'result', call: 'tool call' }
const GAP = 1200 // seconds with no turn that the time range draws as a break: the runs lie hours apart
const runName = (id) => (/^r\d+$/.test(id) ? `Run ${id.slice(1)}` : id)
const TOOLS = {
  Task: 'Starts a subagent, whose session sits under this one', Bash: 'Runs a shell command; its result gives the exit code',
  Read: 'Reads a file', Edit: 'Changes a file', Grep: 'Searches files; its result lists the files that match', WebSearch: 'Searches the web',
}
const OUTCOMES = {
  ok: 'The result came back with no error flag and no denial', error: 'The harness flagged the result as an error (is_error, or isError in r1)',
  denied: 'The result says permission to use the tool was denied',
}
const FILE_TYPES = {
  '.py': 'A Python file outside the tests', 'test .py': 'A Python file under tests/ or named test_*',
  'test .json': 'A JSON file under tests/, such as a fixture', '.md': 'A Markdown file', '.toml': 'A TOML file, such as pyproject.toml',
}

let data = null // the reader's overview: {runs, sessions, spawns, items, counts, fcounts, colours, groups}
let items = [] // the calls and messages the filters keep, in time order
let chosen = null // the lane read: a session's id, or a group's key under another Rows choice
let seq = 0
const S = {} // the sessions by id
const names = {} // each session's name, its agent numbered when its run has two
const kids = {} // the sessions each session started, in the order it started them
const spawnOf = {} // the Task call that started a session: {ref, session, child, time, duration}
const teams = {} // each run's team
const turnsOf = new Map() // a session's turns, or a selection's, as the reader sent them; null while they come
const whole = new Map() // a call's whole input and what came back, once its turn opens
let loaded
const ready = new Promise((ok) => { loaded = ok })

const laneName = (id) => (S[id] ? (S[id].parent ? names[id] : `${runName(S[id].run)} · ${names[id]}`) : id)
const runTitle = (id) => (teams[id] ? `${runName(id)} · ${teams[id]}` : runName(id))
const bySession = () => ln.field === 'session'

// Color by, the one color: the speaker, the tool, the file type, the outcome or a label
const colour = colorBy({
  // each field says what it is, and `meanings` what the values the transcripts' format fixes mean (reader.py's notes)
  fields: [
    {
      name: 'speaker', title: 'Speaker', description: 'Who wrote the turn: the agent whose transcript holds it; for a prompt, the agent that started the session, or user for a lead',
      meanings: { lead: 'The session a run starts with, which starts the subagents', user: "The person who wrote a lead's prompt" },
    },
    { name: 'tool', title: 'Tool', description: 'The tool a call used, Agent read as Task', meanings: TOOLS },
    { name: 'file type', title: 'File type', description: "The extension of the call's first path, test files apart; none for a call with no file", meanings: FILE_TYPES },
    { name: 'outcome', title: 'Outcome', description: 'denied when the result says so, error when it is flagged, else ok', meanings: OUTCOMES },
  ],
  chips: 'filter',
  onChange: load,
})
// Filter by: which turns show, in the lanes and the transcript; the reader leaves out those of a value turned off
const filter = filterBy({
  fields: [
    // a run by its number alone, which leaves its toggles room in the top row; its team is in its lanes' names
    { name: 'run', title: 'Run', description: "The run a session belongs to: a folder under runs/, its team named in the run's index", nameOf: runName },
    { name: 'agent', title: 'Agent', description: "The agent whose transcript holds the turn: lead, or a subagent's type" },
    {
      name: 'kind', title: 'Turn', description: 'What the turn is', values: ['prompt', 'text', 'call', 'result'], nameOf: (k) => KIND[k] || k,
      meanings: {
        prompt: "What the session was asked: the user's words for a lead, the Task call's prompt for a subagent", text: 'What the agent said along the way',
        call: 'A tool call and what came back', result: "The agent's last words, which go back to the session that started it",
      },
    },
    { name: 'tool', title: 'Tool', description: 'The tool a call used', meanings: TOOLS },
    { name: 'outcome', title: 'Outcome', description: 'denied when the result says so, error when it is flagged, else ok', meanings: OUTCOMES },
    { name: 'file type', title: 'File type', description: "The extension of the call's first path", meanings: FILE_TYPES },
  ],
  onChange: load,
})
// Rows: what the lanes are; by session they are each run's tree, a lead with the subagents it started under it
const ln = rows({
  fields: [
    { name: 'session', title: 'Session', description: 'A lane per session, each subagent under the session that started it', nameOf: laneName, parentOf: (id) => (S[id] ? S[id].parent : null) },
    { name: 'agent', title: 'Agent', description: "A lane per agent: lead, or a subagent's type, across the runs" },
    { name: 'run', title: 'Run', description: 'A lane per run', nameOf: runTitle },
    { name: 'tool', title: 'Tool', description: 'A lane per tool, the messages under no tool' },
  ],
  onChange: () => {
    chosen = null
    load()
  },
})
const q = search({ words: 'search', onChange: load })
// the one control for time: every turn over the whole span, a break where the runs lie hours apart
const range = timeRange({ gap: GAP })
// with a label chosen, a turn's value is the reader's, so the lanes need not ask thimble for each turn's marks
const valueOf = (it) => (colour.label ? (data && data.colours[it.ref]) ?? null : colour.valueOf(it))
const laneColour = { keeps: () => true, valueOf, colourOf: (v) => colour.colourOf(v) }
// the lanes: each turn's bar in its hue, a call that ran past its cell (a Task call while its subagent ran) a line in its
// hue, a cell where most calls failed a red ×; the transcript's turns in view on the selection background
const overview = lanes({
  rows: ln,
  colour: laneColour,
  time: (it) => it.time,
  end: (it) => it.time + (it.duration || 0),
  problem: (it) => it.kind === 'call' && it.outcome !== 'ok',
  words: { problem: 'failed', record: 'turn' },
  onPick: (lane) => read(String(lane.key)),
  onMark: (it) => goTo(it.ref),
})
const pane = side({ key: 'turn' })
const split = divider()
// the transcript: each turn its clock, speaker and words, a tool call one line; Enter opens a turn in the side pane
const tr = transcript({ key: 'turns' })
// the label filter changes which records the reader keeps, and a label's values arrive while it runs
onLabels(() => load())

async function load() {
  const my = ++seq
  let got
  try {
    got = await fetch({ op: 'overview', colour: colour.query(), filter: filter.query(), rows: ln.query(), search: q.text.trim() }, { key: 'overview' })
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  if (my !== seq) return
  data = got
  colour.counts(data.counts)
  filter.counts(data.fcounts)
  sessions()
  // under a label, a turn's lane is the reader's value of it (`group`); under a field, the kit reads the field
  items = data.items
  if (ln.label) for (const it of items) it.group = data.groups[it.ref] ?? null
  range.data({ times: items.map((it) => it.time), values: (i) => valueOf(items[i]) })
  loaded()
}

// each session's name, its agent numbered when its run has two; the sessions each started, and the call that did
function sessions() {
  const seen = {}
  for (const r of data.runs) teams[r.id] = r.team
  for (const k of Object.keys(kids)) delete kids[k]
  for (const k of Object.keys(spawnOf)) delete spawnOf[k]
  for (const s of data.sessions) {
    S[s.id] = s
    seen[s.run + s.agent] = (seen[s.run + s.agent] || 0) + 1
    names[s.id] = seen[s.run + s.agent] > 1 ? `${s.agent} ${seen[s.run + s.agent]}` : s.agent
  }
  for (const sp of data.spawns) {
    spawnOf[sp.child] = sp
    ;(kids[sp.session] = kids[sp.session] || []).push(sp.child)
  }
}

// a session's turns, or a selection's, fetched once; null until they come
function turnsFor(key, query) {
  if (!turnsOf.has(key)) {
    turnsOf.set(key, null)
    fetch({ op: 'turns', ...query }).then((got) => turnsOf.set(key, got.turns), () => turnsOf.delete(key))
  }
  return turnsOf.get(key)
}

// a turn as the transcript draws it: a call is a tool turn, a Task call naming the subagent it started; its whole input
// and output once it opened
function turnOf(it) {
  const call = it.kind === 'call'
  const w = whole.get(it.ref)
  const to = call && it.child && S[it.child] ? `→ ${names[it.child]}  ` : ''
  return {
    ...it, t: it.time, kind: call ? 'tool' : it.kind === 'prompt' ? 'prompt' : 'text',
    input: call ? to + (w && !w.reading ? w.input : it.input) : undefined, output: w ? (w.reading ? '◌ reading it' : w.output) : undefined,
    error: call && it.outcome !== 'ok',
  }
}

// a call opened: its whole input and what came back, fetched once
async function opened(turn) {
  if (turn.kind !== 'tool' || whole.has(turn.ref)) return
  whole.set(turn.ref, { reading: true })
  whole.set(turn.ref, await fetch({ op: 'record', ref: turn.ref }))
}

// read a lane: its turns in the transcript, from the first
function read(key) {
  chosen = key
  pane.hide()
  overview.choose(key)
  const first = (turnsOf.get(`s:${key}`) || [])[0]
  if (first) tr.list.choose(first.ref)
}

// a turn to show, from a lane, a link or a citation: its session read, the turn chosen and opened in the side pane
async function goTo(ref) {
  await ready
  let it = items.find((x) => x.ref === ref)
  if (!it && (q.text || filter.query())) {
    // a turn the search or Filter by hides: both put back, so it shows
    q.set('')
    if (filter.query()) filter.choose(null)
    await load()
    it = items.find((x) => x.ref === ref)
  }
  if (!it) return
  if (!range.has(it.time)) range.set(null)
  if (bySession()) chosen = it.session
  overview.choose(chosen)
  tr.list.show(ref)
  pane.show(ref)
  opened(turnOf(it))
}

// a citation: a call or a message in its session's transcript, a session read, a run filtered to with its lead read
onOpen(async (place) => {
  const t = (place && place.target) || {}
  if (t.call || t.message) return goTo(t.call || t.message)
  await ready
  if (t.run) {
    filter.choose('run')
    for (const r of data.runs) if ((r.id === t.run) !== filter.isOn(r.id)) filter.toggle(r.id)
    const lead = data.sessions.find((s) => s.run === t.run && !s.parent)
    if (lead) read(lead.id)
    return
  }
  if (t.session) {
    if (!bySession()) ln.choose('session')
    read(t.session)
  }
})

// ------------------------------------------------------------------------------------------------ the view

// what links the session read to the others, on a row or two: the session that started it and when (a click reads it at
// that call), when its result came back, and the subagents it started (a click reads one)
function links(d, s) {
  const parts = [] // each a list of words that stay on one row, each [words, how]: how 'dim', or {on, tip} for a link
  const sp = spawnOf[s.id]
  if (sp && S[sp.session]) {
    const by = names[sp.session]
    const at = { on: () => goTo(sp.ref), tip: `read ${by} at the Task call that started ${names[s.id]}` }
    parts.push([['started by', 'dim'], [by, at], [hms(sp.time), 'dim']])
    parts.push([[`result back to ${by}`, 'dim'], [hms(sp.time + sp.duration), { ...at, tip: `read ${by} at that call, where the result came back` }]])
  } else if (!s.parent) parts.push([[`lead of ${runTitle(s.run)}`, 'dim']])
  const ks = kids[s.id] || []
  // each subagent a part of its own, after a comma, so its name and time stay on one row
  ks.forEach((k, i) => parts.push(Object.assign([...(i ? [] : [['subagents', 'dim']]), [names[k], { on: () => read(k), tip: `read ${names[k]}` }], [hms(spawnOf[k].time), 'dim']], { sep: i ? ', ' : null })))
  // the parts one after another, ` · ` between them; a part that does not fit the row starts the next
  let r = d.row()
  parts.forEach((p, i) => {
    const sep = p.sep || ' · '
    const w = p.reduce((n, [words]) => n + 1 + width(words), width(sep))
    if (i && r.x + w > d.cols) {
      if (p.sep) r.add(p.sep.trim(), { d: true })
      r.end()
      r = d.row().gap(2)
    } else if (i) r.add(sep, { d: true })
    p.forEach(([words, how], j) => {
      if (j) r.gap(1)
      r.add(words, how === 'dim' ? { d: true } : {}, { ...(how === 'dim' ? {} : how), max: Math.max(1, r.room) })
    })
  })
  r.end()
}

draw((d) => {
  // the top row: the search, Filter by with its toggles, Rows, Color by with its chips, Reset at R; in a narrow panel the
  // search and Filter by on a row of their own
  if (d.cols < 72) {
    const r = d.row()
    q.add(r).gap()
    filter.add(r, { max: r.room }).end()
    colour.draw(d, (rr) => ln.add(rr).gap())
  } else {
    colour.draw(d, (r) => {
      q.add(r).gap()
      filter.add(r, { max: Math.max(24, Math.floor(d.cols * 0.45)) }).gap()
      ln.add(r).gap()
    })
  }
  if (!data) {
    d.row().add('◌ reading the sessions', { d: true }).end()
    return
  }
  d.sub(plural(new Set(items.map((it) => it.run)).size, 'run'), plural(new Set(items.map((it) => it.session)).size, 'session'), plural(items.length, 'turn'))
  // the names in a column at the left, the time across the rest: the strip, the lanes and the axis share it; a lead's
  // name whole in it at any width
  const gutter = Math.max(16, Math.min(Math.floor(d.cols / 4), 4 + Math.max(...data.sessions.map((s) => 2 * s.depth + width(laneName(s.id))))))
  // the overview's rows: the lanes' rows and the range's, up to a little over half the rows left, so the transcript
  // keeps the rest
  const sessionsIn = new Set(items.filter((it) => range.has(it.time)).map((it) => it.session)).size
  const top = split.rows(d, Math.min(Math.floor(d.left * 0.55), 4 + Math.max(3, sessionsIn)))
  const y0 = d.y
  range.draw(d, { gutter })
  const scale = range.scale(d.cols - gutter)
  const legend = () => overview.legend()
  overview.draw(d, { items: items.filter((it) => range.has(it.time)), scale, gutter, room: Math.max(2, top - (d.y - y0) - 1), span: tr.list })
  axis(d, scale, { gutter, gap: 8, legend: legend() })
  // the lane read stays chosen while it has a turn in the range, though a folded lane may hold it; else the first
  const ls = overview.lanes.filter((l) => !l.heading)
  const lane = bySession() ? null : ls.find((l) => String(l.key) === chosen)
  if (bySession() ? !items.some((it) => it.session === chosen && range.has(it.time)) : !lane) chosen = ls.length ? String(ls[0].key) : null
  if (overview.chosen !== chosen) overview.choose(chosen)
  d.blank()

  // the reading: what links the session to the others, then its transcript, titled with what it shows and how many
  const session = bySession() && S[chosen]
  const its = session ? items.filter((it) => it.session === chosen) : lane ? lane.items : null
  if (session) links(d, session)
  if (!its) {
    d.row().gap(2).add('no turn holds the search or passes the filters', { d: true }).end()
    return
  }
  const keep = new Set(its.filter((it) => range.has(it.time)).map((it) => it.ref))
  const key = session ? `s:${chosen}` : `r:${[...keep].sort().join(' ')}`
  const all = turnsFor(key, session ? { session: chosen } : { refs: [...keep] })
  const title = session ? `${names[chosen]} · ${runTitle(session.run)}` : `${ln.by ? ln.by.title : 'all'}: ${(ls.find((l) => String(l.key) === chosen) || {}).name}`
  if (!all) {
    d.row().add(title, { b: true }).end()
    d.row().gap(2).add('◌ reading the transcript', { d: true }).end()
    return
  }
  const turns = all.filter((t) => keep.has(t.ref)).map(turnOf)
  const total = session ? all.length : turns.length
  // how many turns it shows, and when the session ran or how many sessions the lane holds, where the panel has room
  const span = session ? `${hms(session.start)} – ${hms(session.end)}` : plural(new Set(turns.map((t) => t.session)).size, 'session')
  const count = `${turns.length < total ? `${turns.length} of ${total}` : turns.length} turns${d.cols >= 72 ? ` · ${span}` : ''}`
  tr.draw(d, { turns, title, count, colour, side: pane, onOpen: opened, empty: range.full ? 'no turn holds the search or passes the filters' : 'no turn in this time range' })
  // moving between sessions: the next or previous lane, the subagent the chosen Task call started, the session that
  // started this one
  const at = ls.findIndex((l) => String(l.key) === chosen)
  if (ls.length > 1) d.key(['n', 'p'], 'for the next or previous lane', (k) => read(String(ls[(at + (k === 'n' ? 1 : ls.length - 1)) % ls.length].key)))
  const pick = turns.find((t) => t.ref === tr.chosen)
  if (pick && pick.child && S[pick.child]) d.key('s', `to read ${names[pick.child]}`, () => read(pick.child))
  if (session && session.parent && S[session.parent]) d.key('u', `to read ${names[session.parent]}`, () => (spawnOf[session.id] ? goTo(spawnOf[session.id].ref) : read(session.parent)))
})

load()
