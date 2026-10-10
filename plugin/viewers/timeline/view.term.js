// Timeline in the terminal: a ferry operator's events from five sources on one time axis, as view.html draws them in
// the browser. The top rows search, filter (Filter by), group the lanes (Rows) and color (Color by); the time range's
// strip picks the time the lanes and the list show; an event opens in the side pane with the event it answers, those
// that answer it, and its place. One fetch gives the events the search and Filter by keep, each with its Color by value
// and its Rows group.
import { COLORS, axis, colorBy, columns, dayOf, details, divider, draw, dur, fetch, filterBy, hms, list, onLabels, onOpen, onReset, plural, rows as rowsBy, search, side, timeline, timeRange, when } from 'thimble-term'

const GUTTER = 12 // the lanes' names, which the strip, the axis and the lanes leave room for
const BURST_GAP = 6 * 3600

let E = [] // the events shown, in time order: {r, t, ref, source, kind, actor, service, severity, outcome, incident, text, value, group}
let span = null
let picked = null // the lane chosen, whose events the list shows: {key, value, name}
let keep = [] // the row a citation opened, kept whatever the filters
let narrowTo = null // an incident a citation narrows Filter by to, once its values are in
const records = new Map() // an event opened in the side pane -> its record in full
let loaded = false
let seq = 0
let markLoaded
const ready = new Promise((ok) => (markLoaded = ok))

// the view's fields, which Filter by, Rows and Color by each offer: what each is, and `meanings` what the values the
// sources' formats fix mean (reader.py's notes), which the menus and a value's tip show
const SOURCES = ['alert', 'deploy', 'agent', 'chat', 'ticket']
const FIELDS = [
  { name: 'service', title: 'Service', description: "The service the event is about: its svc or service, the ticket's in tickets/index.csv, else its summary's first word" },
  {
    name: 'kind', title: 'Kind', description: "What happened, from its state, event, Status or action: an alert firing read as fired, a ticket's first message as opened",
    meanings: {
      fired: 'An alert started firing', resolved: 'An alert stopped firing; it answers the alert it resolves',
      started: 'A deploy started', finished: 'A deploy finished, ok or failed', rollback: 'A deploy put an earlier version back',
      message: 'A chat message', opened: "A ticket's first message, or an agent opening an incident",
      updated: "A ticket's later message that does not close it", closed: "A ticket's message that closes it, or an agent closing an incident",
      restart: 'An agent restarted a replica or a worker', page: 'An agent paged a person, or escalated a page',
      scale: 'An agent changed how many replicas a service runs', tag: 'An agent tagged support tickets',
      pause: 'An agent paused, as a person asked in chat', resume: 'An agent resumed, as a person asked in chat',
    },
  },
  {
    name: 'incident', title: 'Incident',
    description: "The incident the event belongs to: its incident, an inc- channel, an INC number in its text or the ticket's in tickets/index.csv; a deploy's later steps take its incident",
  },
  {
    name: 'severity', title: 'Severity', description: "The alert's severity, or the ticket's priority in tickets/index.csv",
    meanings: {
      critical: 'An alert of severity critical', warning: 'An alert of severity warning',
      urgent: 'A ticket of priority urgent in tickets/index.csv', high: 'A ticket of priority high in tickets/index.csv',
      normal: 'A ticket of priority normal in tickets/index.csv', low: 'A ticket of priority low in tickets/index.csv',
    },
  },
  {
    name: 'outcome', title: 'Outcome', description: 'The result an event records: ok, failed or held',
    meanings: {
      ok: "The agent's action or the deploy succeeded", failed: "The agent's action or the deploy failed, such as a restart that timed out",
      held: 'The agent held the action back, such as a page held until 07:00 in quiet hours',
    },
  },
  { name: 'actor', title: 'Actor', description: 'Who acted: a login or chat id as chat/users.json names it, or the agent', meanings: { monitor: 'The monitor, which raises and resolves the alerts' } },
  {
    name: 'source', title: 'Source', description: "The file the event comes from: alerts, deploys, the agents' log, chat or tickets", values: SOURCES,
    meanings: {
      alert: "One of the monitor's alerts, in alerts/*.jsonl", deploy: 'A deploy tool event, a row of deploys.csv',
      chat: "A message in a channel's file in chat/", ticket: "A support ticket's message, in tickets/*.txt",
      agent: "An automated agent's action, a line of agents.log",
    },
  },
]

const color = colorBy({ fields: FIELDS, initial: 'service', onChange: load })
const filter = filterBy({ fields: FIELDS, initial: 'incident', onChange: load })
const rows = rowsBy({ fields: FIELDS, initial: 'source', onChange: () => { pick(null); load() } })
const range = timeRange({ onChange: () => {} })
const q = search({ words: 'search events', onChange: load })
// the lanes draw each event in the value the reader gave it, which holds for a label too; a cell where most events
// failed is `×` in red, always shown (there is no key that hides them)
const painted = { keeps: () => true, valueOf: (e) => e.value, colorOf: (v) => color.colorOf(v) }
const ln = timeline({
  rows, color: painted, problem: (e) => e.outcome === 'failed', words: { problem: 'failed', record: 'event' },
  onPick: (lane) => pick(picked && picked.key === lane.key ? null : lane),
  onMark: (e) => show(e.r),
})
if (!ln.isOn('problem')) ln.toggle('problem')
const pane = side({ key: 'event' })
const split = divider()
const events = list({ key: (e) => e.r })
onReset({ changed: () => picked !== null || keep.length > 0, reset: () => { pick(null); keep = []; load() } })
// the label filter or a label's values changed: fetch again, since the reader keeps only what it keeps
onLabels(() => load())

async function load() {
  const my = ++seq
  const query = { op: 'overview', color: color.query(), filter: filter.query(), rows: rows.query(), q: q.text.trim(), keep }
  const cols = {}
  const counts = {}
  const fcounts = {}
  let from = 0
  try {
    do {
      const page = await fetch({ ...query, from }, { key: 'events' })
      if (my !== seq) return
      if (page.span) span = page.span
      for (const k in page.cols) (cols[k] = cols[k] || []).push(...page.cols[k])
      for (const k in page.counts) counts[k] = (counts[k] || 0) + page.counts[k]
      for (const k in page.fcounts) fcounts[k] = (fcounts[k] || 0) + page.fcounts[k]
      from = page.next
    } while (from != null)
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  E = (cols.r || []).map((_, i) => Object.fromEntries(Object.keys(cols).map((k) => [k, cols[k][i]])))
  color.counts(counts)
  filter.counts(fcounts)
  // the overview keeps the whole span whatever the filters keep, so the window stays where it was
  const pad = (span[1] - span[0]) * 0.005
  range.data({ times: E.map((e) => e.t), values: E.map((e) => e.value), span: [span[0] - pad, span[1] + pad] })
  loaded = true
  markLoaded()
  if (narrowTo !== null && filter.field === 'incident') narrowNow()
}

function pick(lane) {
  picked = lane ? { key: lane.key, value: lane.value, name: lane.name } : null
  ln.choose(picked ? picked.key : null)
}
const inLane = (e) => !picked || (rows.groupOf(e) ?? null) === picked.value

// the window on an incident's main burst, with a little room on each side: the run of its events with no gap over
// BURST_GAP that holds the most of them, so a follow-up days later does not shrink the burst to a sliver
function frame(incident) {
  const ts = E.filter((e) => e.incident === incident).map((e) => e.t)
  if (!ts.length) return
  let best = [0, 0]
  let from = 0
  for (let i = 1; i <= ts.length; i++) {
    if (i < ts.length && ts[i] - ts[i - 1] <= BURST_GAP) continue
    if (i - from > best[1] - best[0] + 1) best = [from, i - 1]
    from = i
  }
  const a = ts[best[0]]
  const b = ts[best[1]]
  const pad = Math.max(300, (b - a) * 0.05)
  range.set(a - pad, b + pad)
}

// an incident's citation: Filter by on Incident with that incident alone on, and the window on its burst
function narrow(incident) {
  narrowTo = incident
  if (filter.field === 'incident') narrowNow()
  else filter.choose('incident') // its onChange fetches the incidents' counts, and load() narrows then
}
function narrowNow() {
  const want = narrowTo
  narrowTo = null
  frame(want)
  for (const v of filter.values) if ((v.value === want) !== v.on) filter.toggle(v.value)
}

// an event in the side pane from anywhere: a link in another event's details, a lane, a citation
async function show(r) {
  if (!E.some((e) => e.r === r)) {
    keep = [r]
    await load()
  }
  const e = E.find((x) => x.r === r)
  if (!e) return
  if (!range.has(e.t)) {
    const w = range.to - range.from
    range.set(e.t - w / 2, e.t + w / 2)
  }
  if (!inLane(e)) pick(null)
  events.choose(r)
  pane.show(r)
  await readRecord(r)
}

async function readRecord(r) {
  if (records.has(r)) return
  records.set(r, null)
  records.set(r, await fetch({ op: 'record', r, keep }, { key: 'record' }))
}

// a citation: an event in the side pane, an incident narrowed to and framed, a day or a window framed
onOpen(async (place) => {
  const t = (place && place.target) || {}
  await ready
  if (t.r != null) return show(t.r)
  if (t.incident) return narrow(t.incident)
  if (t.day) {
    const a = Date.parse(`${t.day}T00:00:00Z`) / 1000
    return range.set(a, a + 86400)
  }
  if (t.from && t.to) range.set(Date.parse(`${t.from}:00Z`) / 1000, Date.parse(`${t.to}:00Z`) / 1000)
})

// the list's columns in the width it draws in: the kind from 60 cells (in a narrower list Color by and the details give
// it), the actor from 88 and the incident from 110 (Filter by and the details have it too); the time right-aligned, a
// day's first event with its date before it, to the minute in a list narrower than 60
const WIDTHS = { time: 15, source: 6, kind: 11, actor: 10, incident: 8 }
const HEADINGS = { time: 'time', source: 'source', kind: 'kind', actor: 'actor', incident: 'incident', text: 'text' }
function columnsFor(w) {
  const keys = ['time', 'source', ...(w >= 60 ? ['kind'] : []), ...(w >= 88 ? ['actor'] : []), ...(w >= 110 ? ['incident'] : []), 'text']
  const time = w >= 60 ? WIDTHS.time : 12
  return { keys, step: w >= 60 ? 1 : 60, cols: columns(keys.map((k) => (k === 'text' ? { grow: true } : k === 'time' ? { w: time, align: 'right' } : { w: WIDTHS[k] })), w - 6) }
}
const ID = { alert: 'alert id', deploy: 'deploy id', chat: 'message id', ticket: 'ticket message' }

draw((d) => {
  // the top rows: the search and Filter by; Rows, then Color by with its chips and Reset at R
  const top = d.row()
  q.add(top).gap()
  filter.add(top)
  top.end()
  color.draw(d, (r) => rows.add(r).gap())
  if (!loaded) {
    d.row().add('◌ loading the events…', { d: true }).end()
    return
  }
  // the overview, in the rows the divider gives it: the readout and the strip, a lane per group of Rows with
  // the events in the range, and the axis
  const shown = E.filter((e) => range.has(e.t))
  // the reader filters, so Filter by counts the events here for its menu's words
  for (const e of E) filter.tally(e)
  const n = split.rows(d, Math.min(4 + rows.groups(shown).length, Math.max(7, Math.floor(d.left / 2))))
  range.draw(d, { gutter: GUTTER })
  const scale = range.scale(d.cols - GUTTER)
  ln.draw(d, { items: shown, scale, gutter: GUTTER, room: Math.max(1, n - 3), span: events })
  axis(d, scale, { gutter: GUTTER })
  d.blank()
  // the events in the range and in the lane chosen, each row its mark in its Color by hue; a day's first event gives
  // the date, so no heading row breaks the list
  const items = shown.filter(inLane)
  const dated = new Set(items.filter((e, i) => !i || dayOf(items[i - 1].t) !== dayOf(e.t)))
  events.draw(d, {
    title: picked ? `${rows.by ? `${rows.by.title}: ` : ''}${picked.name}` : 'In the range',
    count: plural(items.length, 'event'),
    items,
    color,
    value: (e) => e.value,
    side: pane,
    sideTitle: (e) => `${e.source} ${e.kind} · ${hms(e.t)}`,
    empty: 'no event',
    // the header stands in the list's own width; a row's cells in that width less the track (3 cells)
    header: (r) => {
      const { keys, cols } = columnsFor(r.d.cols)
      cols.header(r, keys.map((k) => HEADINGS[k]))
    },
    row: (e, r) => {
      const { keys, step, cols } = columnsFor(r.d.cols + 3)
      // a failed outcome as `×` before its kind (before its text where the kind has no column), in the problem red as
      // the lanes draw it
      const failed = e.outcome === 'failed'
      const value = { time: dated.has(e) ? when(e.t, step) : hms(e.t), source: e.source, kind: `${failed ? '× ' : ''}${e.kind}`, actor: e.actor, incident: e.incident, text: `${failed && !keys.includes('kind') ? '× ' : ''}${e.text}` }
      cols.cells(r, keys.map((k) => value[k]), keys.map((k) => (failed && (k === 'kind' || (k === 'text' && !keys.includes('kind'))) ? { fg: COLORS.problem } : k === 'kind' || k === 'text' ? {} : { d: true })))
    },
    onOpen: (e) => readRecord(e.r),
    ask: (e) => ({ ref: e.ref, text: e.text }),
    detail: (e, dd) => {
      const got = records.get(e.r)
      if (!got) {
        dd.row().add('◌ reading the event', { d: true }).end()
        return
      }
      const rec = got.record
      const link = (b) => ({ when: hms(b.t), words: `${b.source} ${b.kind}`, text: b.text, on: () => show(b.r) })
      // its facts say what its line holds, so the line itself is a step away, behind ↗, which also asks about it
      details(dd, {
        text: rec.text,
        facts: [['service', rec.service], ['severity', rec.severity], ['outcome', rec.outcome], ['incident', rec.incident], ['by', rec.actor], [ID[rec.source] || 'id', rec.id]],
        groups: [
          { title: got.answers ? `Response to · ${dur(rec.took)} earlier` : '', rows: got.answers ? [link(got.answers)] : [] },
          { title: `Responses · ${got.answered.length}`, rows: got.answered.map(link) },
        ],
        place: got.ref,
      })
    },
  })
})

load()
