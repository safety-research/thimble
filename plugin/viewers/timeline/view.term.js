// Timeline in the terminal: a ferry operator's events from five sources on one time axis, as view.html draws them in
// the browser. The top row searches, narrows to an incident and colors by a field or a label; the time range's
// overview strip picks the time the lanes (one per source) and the list show; the list opens an event in place with
// what it answers and what answers it, its lines and its place. One fetch gives the events the search, the incident
// and Color by keep; the strip, the lanes and the list's marks take Color by's hues.
import { axis, choice, colorBy, columns, dayName, dayOf, details, draw, dur, fetch, hms, list, maxBin, onLabels, onOpen, onReset, search, strip, timeRange } from 'thimble-term'

const SOURCES = ['alert', 'deploy', 'agent', 'chat', 'ticket']
const GUTTER = 8 // the lanes' names, which the strip, the axis and the lanes leave room for
const BURST_GAP = 6 * 3600

let E = [] // the events shown, in time order: {r, t, ref, source, kind, actor, service, severity, outcome, incident, text, value}
let span = null
let flags = [] // each incident's first time: [{t, label}]
let keep = [] // the row a citation opened, kept whatever the label filter
const records = new Map() // a row opened in place -> its record in full
let loaded = false
let seq = 0

const colour = colorBy({
  // each field says what it is, and `meanings` what the values the sources' formats fix mean (reader.py's notes),
  // which the menu and a chip's tip show
  fields: [
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
      name: 'source', title: 'Source', description: "The file the event comes from: alerts, deploys, the agents' log, chat or tickets",
      meanings: {
        alert: "One of the monitor's alerts, in alerts/*.jsonl", deploy: 'A deploy tool event, a row of deploys.csv',
        chat: "A message in a channel's file in chat/", ticket: "A support ticket's message, in tickets/*.txt",
        agent: "An automated agent's action, a line of agents.log",
      },
    },
  ],
  chips: 'filter',
  onChange: load,
})
const range = timeRange({ onChange: () => {} })
const q = search({ words: 'search events', onChange: load })
// an incident picked narrows to it and frames its span, as its citation does; all frames the whole span again
const incident = choice({ title: 'incident', all: 'all', key: 'i', onChange: async (v) => {
  await load()
  if (v) frame()
  else range.set(null)
} })
const events = list({ key: (e) => e.r })
onReset({ changed: () => events.open !== null, reset: () => { events.show(events.chosen, false); keep = []; load() } })
// the label filter or a label's values changed: fetch again, since the reader keeps only what it keeps
onLabels(() => load())

async function load() {
  const my = ++seq
  const query = { op: 'overview', colour: colour.query(), incident: incident.value || '', q: q.text.trim(), keep }
  const cols = {}
  const counts = {}
  let from = 0
  try {
    do {
      const page = await fetch({ ...query, from }, { key: 'events' })
      if (my !== seq) return
      if (page.span) {
        span = page.span
        flags = Object.entries(page.starts).map(([label, t]) => ({ t, label }))
      }
      for (const k in page.cols) (cols[k] = cols[k] || []).push(...page.cols[k])
      for (const k in page.counts) counts[k] = (counts[k] || 0) + page.counts[k]
      from = page.next
    } while (from != null)
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  E = (cols.r || []).map((_, i) => Object.fromEntries(Object.keys(cols).map((k) => [k, cols[k][i]])))
  incident.values = flags.map((f) => f.label)
  colour.counts(counts)
  // the overview keeps the whole span whatever the search keeps, so the window stays where it was
  const pad = (span[1] - span[0]) * 0.005
  range.data({ times: E.map((e) => e.t), values: E.map((e) => e.value), span: [span[0] - pad, span[1] + pad], marks: flags })
  loaded = true
}

// the window on an incident's main burst, with a little room on each side: the run of its events with no gap over
// BURST_GAP that holds the most of them, so a follow-up days later does not shrink the burst to a sliver
function frame() {
  if (!E.length) return
  let best = [0, 0]
  let from = 0
  for (let i = 1; i <= E.length; i++) {
    if (i < E.length && E[i].t - E[i - 1].t <= BURST_GAP) continue
    if (i - from > best[1] - best[0] + 1) best = [from, i - 1]
    from = i
  }
  const a = E[best[0]].t
  const b = E[best[1]].t
  const pad = Math.max(300, (b - a) * 0.05)
  range.set(a - pad, b + pad)
}

// an event opened in place from anywhere: a link in another event's details, a lane, a citation
async function show(r) {
  if (!E.some((e) => e.r === r)) {
    keep = [r]
    q.set('')
    incident.set(null)
    await load()
  }
  const e = E.find((x) => x.r === r)
  if (!e) return
  if (!range.has(e.t)) {
    const w = range.to - range.from
    range.set(e.t - w / 2, e.t + w / 2)
  }
  events.show(r)
  await readRecord(r)
}

async function readRecord(r) {
  if (records.has(r)) return
  records.set(r, null)
  records.set(r, await fetch({ op: 'record', r, keep }, { key: 'record' }))
}

// a citation: an event opened in place, an incident narrowed to and framed, a day or a window framed
onOpen(async (place) => {
  const t = (place && place.target) || {}
  if (t.r != null) return show(t.r)
  if (t.incident) {
    q.set('')
    incident.set(t.incident)
    return
  }
  if (t.day) {
    const a = Date.parse(`${t.day}T00:00:00Z`) / 1000
    return range.set(a, a + 86400)
  }
  if (t.from && t.to) range.set(Date.parse(`${t.from}:00Z`) / 1000, Date.parse(`${t.to}:00Z`) / 1000)
})

draw((d) => {
  // the top row: the search, the incident, Color by with its chips, Reset at R
  colour.draw(d, (r) => {
    q.add(r).gap()
    incident.add(r).gap()
  })
  if (!loaded) {
    d.row().add('◌ reading the events', { d: true }).end()
    return
  }
  // the time range's readout and overview strip, over the lanes' time column
  range.draw(d, { gutter: GUTTER })
  const scale = range.scale(d.cols - GUTTER)
  const opened = E.find((e) => e.r === events.open)
  // a lane per source, when the panel has the rows for them: the events in the range in the scale's bins, each bin in
  // the hue most of its events take, every lane on one height scale; the opened event's time a guide through them
  if (d.rows >= 26) {
    const bySource = SOURCES.map((s) => E.filter((e) => e.source === s))
    const max = maxBin(scale, bySource)
    bySource.forEach((items, l) => {
      const r = d.row().add(SOURCES[l].padEnd(GUTTER), { d: true })
      const x0 = r.x
      r.runsOf(strip(scale, items, { value: (e) => e.value, colour, max, guide: opened ? opened.t : null }))
      // a click on a lane opens the event nearest that time in that lane
      r.hits.push({ x0, x1: x0 + scale.cols, tip: `${SOURCES[l]}: a click opens the event nearest that time`, on: (x) => {
        const t = scale.t(x)
        const near = items.filter((e) => range.has(e.t) && Math.abs(e.t - t) <= scale.step * 3).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0]
        if (near) show(near.r)
      } })
      r.end()
    })
  }
  axis(d, scale, { gutter: GUTTER, marks: flags, onMark: (m) => incident.set(m.label) })
  d.blank()
  // the events in the range, a heading for each day, each row its mark in its Color by hue
  const shown = E.filter((e) => range.has(e.t))
  const items = []
  let day = ''
  for (const e of shown) {
    if (dayOf(e.t) !== day) items.push({ heading: dayName((day = dayOf(e.t), e.t)) })
    items.push(e)
  }
  // the columns the width holds: the actor from 88 cells, the incident from 110 (its menu and the details have it too)
  const shownCols = ['time', 'source', 'kind', ...(d.cols >= 88 ? ['actor'] : []), ...(d.cols >= 110 ? ['incident'] : []), 'text']
  const WIDTHS = { time: 8, source: 6, kind: 10, actor: 10, incident: 7 }
  const cols = columns(shownCols.map((k) => (k === 'text' ? { grow: true } : { w: WIDTHS[k] })), d.cols - 6)
  events.draw(d, {
    items,
    colour,
    value: (e) => e.value,
    empty: 'no event',
    row: (e, r) => {
      // a failed outcome as `×` before its kind in the text's own color, since only Color by's choice takes a color
      const value = { time: hms(e.t), source: e.source, kind: e.outcome === 'failed' ? `× ${e.kind}` : e.kind, actor: e.actor, incident: e.incident, text: e.text }
      cols.cells(r, shownCols.map((k) => value[k]), shownCols.map((k) => (k === 'kind' || k === 'text' ? {} : { d: true })))
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
      const link = (b) => ({ when: hms(b.t), words: `${b.source} · ${b.actor}`, text: b.text, on: () => show(b.r) })
      details(dd, {
        text: rec.text,
        facts: [['service', rec.service], ['severity', rec.severity], ['outcome', rec.outcome], ['id', rec.id], ['took', rec.took != null ? dur(rec.took) : '']],
        groups: [{ title: 'Answers', rows: got.answers ? [link(got.answers)] : [] }, { title: 'Answered by', rows: got.answered.map(link) }],
        raw: got.raw,
        place: got.ref,
        ask: { ref: got.ref, text: rec.text },
      })
    },
  })
})

load()
