// Linked sessions in the terminal: runs of agent teams on one clock, as view.html draws them in the browser. The top row
// searches the messages and calls, narrows to a run or a session and colors by speaker, tool, file type, outcome or a
// label; the time range's strip, broken where the runs lie hours apart, picks the time the lanes and the list show. A
// lane per session, each subagent under the session that spawned it, shows when the session ran and its messages and
// calls in the Color by hues; the list holds them all in time order, a call's whole input and what came back opened in
// place. One fetch gives what the search, the menu and Color by keep; a row's record in full comes when it opens.
import { axis, choice, colorBy, columns, details, draw, fetch, hms, list, maxBin, onLabels, onOpen, onReset, plural, search, strip, timeRange, width, COLORS } from 'thimble-term'

const KIND = { prompt: 'Prompt', text: 'Text', result: 'Result' }
const GAP = 1200 // seconds with no record that the time range draws as a break: the runs lie hours apart
const secs = (d) => `${d < 10 ? d.toFixed(1) : Math.round(d)} s`
const runName = (id) => (/^r\d+$/.test(id) ? `Run ${id.slice(1)}` : id)

let data = null // the reader's overview: {runs, sessions, scope, calls, messages, counts}
let items = [] // the calls and messages it keeps, in time order
const S = {} // the sessions by id
const names = {} // each session's name, its agent numbered when its run has two
const records = new Map() // a row opened in place -> its record in full
const folded = new Map() // a run the analyst folded (true) or unfolded (false) by its ▸ ▾
let seq = 0

// the one Color by control: Off, the view's own fields and every label, the values as chips in the top row
const colour = colorBy({
  // each field says what it is, and `meanings` what the values the transcripts' format fixes mean (reader.py's notes),
  // which the menu and a chip's tip give; a value with none, such as a subagent's name, shows what the field is
  fields: [
    {
      name: 'speaker', title: 'Speaker', description: 'The agent whose transcript holds the call or message; for a prompt, the agent that spawned the session, or user for a lead',
      meanings: { lead: 'The session a run starts with, in runs/<run>/<session id>.jsonl, which spawns the subagents', user: "The person who wrote a lead's prompt" },
    },
    {
      name: 'tool', title: 'Tool', description: 'The tool the call used, Agent read as Task',
      meanings: {
        Task: 'Spawns a subagent, whose session sits under this one', Bash: 'Runs a shell command; its result gives the exit code',
        Read: 'Reads a file', Edit: 'Changes a file', Grep: 'Searches files; its result lists the files that match', WebSearch: 'Searches the web',
      },
    },
    {
      name: 'file type', title: 'File type', description: "The extension of the call's first path, test files apart; none for a call with no file",
      meanings: {
        '.py': 'A Python file outside the tests', 'test .py': 'A Python file under tests/ or named test_*',
        'test .json': 'A JSON file under tests/, such as a fixture', '.md': 'A Markdown file', '.toml': 'A TOML file, such as pyproject.toml',
      },
    },
    {
      name: 'outcome', title: 'Outcome', description: 'denied when the result says so, error when it is flagged, else ok',
      meanings: {
        ok: 'The result came back with no error flag and no denial', error: 'The harness flagged the result as an error (is_error, or isError in r1)',
        denied: 'The result says permission to use the tool was denied',
      },
    },
  ],
  chips: 'filter',
  onChange: load,
})
// the one control for time: every message and call over the whole span, a break where the runs lie hours apart
const range = timeRange({ gap: GAP })
const q = search({ words: 'search', onChange: load })
// the runs and their sessions as a tree: a run, or a session with the subagents under it
const scope = choice({ title: 'sessions', all: 'all', key: 's', onChange: load })
const rows = list({ key: (it) => it.ref })
// what Reset puts back of this page's own: the row opened in place and the runs folded by hand (the kit puts back the
// chips, the range, the search and the menu)
onReset({
  changed: () => rows.open !== null || folded.size > 0,
  reset: () => {
    rows.show(rows.chosen, false)
    folded.clear()
    load()
  },
})
// the label filter changes which records the reader keeps, and a label's values arrive while it runs
onLabels(() => load())

async function load() {
  const my = ++seq
  let got
  try {
    got = await fetch({ op: 'overview', colour: colour.query(), scope: scope.value || '', search: q.text.trim() }, { key: 'overview' })
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  if (my !== seq) return
  data = got
  colour.counts(data.counts)
  sessions()
  items = [...data.calls, ...data.messages].sort((a, b) => a.time - b.time)
  range.data({ times: items.map((it) => it.time), values: (i) => colour.valueOf(items[i]) })
}

// each session's name, its agent numbered when its run has two; the menu lists every run with its sessions as a tree
function sessions() {
  const seen = {}
  for (const s of data.sessions) {
    S[s.id] = s
    seen[s.run + s.agent] = (seen[s.run + s.agent] || 0) + 1
    names[s.id] = seen[s.run + s.agent] > 1 ? `${s.agent} ${seen[s.run + s.agent]}` : s.agent
  }
  const values = []
  for (const r of data.runs) {
    values.push({ name: `${runName(r.id)} · ${r.team}`, value: `r:${r.id}` })
    for (const s of data.sessions) if (s.run === r.id) values.push({ name: names[s.id], value: `s:${s.id}`, indent: s.depth + 1 })
  }
  scope.values = values
  // a session the label filter no longer keeps
  if (scope.value && !values.some((v) => v.value === scope.value)) scope.set(null)
}

// a message or call to show, from a lane or a citation: opened in place, the range moved to it
async function reveal(ref) {
  if (!items.some((it) => it.ref === ref)) {
    q.set('')
    scope.set(null)
    await load()
  }
  const it = items.find((x) => x.ref === ref)
  if (!it) return
  if (!range.has(it.time)) range.set(null)
  rows.show(ref)
  await readRecord(ref)
}

// a row's record in full, fetched once; each row's fetch is its own, so opening another row drops none
async function readRecord(ref) {
  if (records.has(ref)) return
  records.set(ref, null)
  records.set(ref, await fetch({ op: 'record', ref }))
}

// a citation: a message or call opened in its row, a run or a session as the menu's choice
onOpen((place) => {
  const t = (place && place.target) || {}
  if (t.call || t.message) return reveal(t.call || t.message)
  if (t.run) return scope.set(`r:${t.run}`)
  if (t.session) return scope.set(`s:${t.session}`)
})

// ------------------------------------------------------------------------------------------------ the lanes

// the lanes' rows: each run in scope, then, unless it is folded, its sessions as a tree, each subagent under the
// session that spawned it (`├ ` and `└ `, with `│ ` down the levels above); a run folds to one lane of all its sessions.
// In a range zoomed in, a session that did not run in it has no lane, and a run with none has no row
function laneRows(room) {
  const inScope = new Set(data.scope)
  const ran = (s) => range.full || (s.end >= range.from && s.start <= range.to)
  const runs = data.runs.map((r) => ({ run: r, ss: data.sessions.filter((s) => s.run === r.id && inScope.has(s.id) && ran(s)) })).filter((x) => x.ss.length)
  // a run folds by itself, the largest first, until the lanes fit their room; the analyst's ▸ ▾ comes first
  const fold = new Map(runs.map((x) => [x.run.id, folded.get(x.run.id) === true]))
  const need = () => runs.reduce((n, x) => n + 1 + (fold.get(x.run.id) ? 0 : x.ss.length), 0)
  for (const x of [...runs].sort((a, b) => b.ss.length - a.ss.length)) {
    if (need() <= room) break
    if (folded.get(x.run.id) !== false) fold.set(x.run.id, true)
  }
  const out = []
  for (const x of runs) {
    out.push({ run: x.run, ss: x.ss, folded: fold.get(x.run.id) })
    if (fold.get(x.run.id)) continue
    const shown = new Set(x.ss.map((s) => s.id))
    const kids = (id) => x.ss.filter((s) => (shown.has(s.parent) ? s.parent : null) === id)
    const walk = (id, lead) => {
      const ks = kids(id)
      ks.forEach((s, i) => {
        const last = i === ks.length - 1
        out.push({ session: s, guide: id === null ? '' : `${lead}${last ? '└ ' : '├ '}` })
        walk(s.id, id === null ? '' : `${lead}${last ? '  ' : '│ '}`)
      })
    }
    walk(null, '')
  }
  return out
}

// one lane over the scale's cells: `─` in the rule gray while a session ran, a call that ran on past its cell `─` in
// its hue, a cell's messages and calls a bar in the hue most of them take, every lane on one height, and `×` in a cell
// where most of them failed, in the text's own color, since only Color by's choice takes a color
function lane(scale, its, spans, max) {
  const cells = Array.from({ length: scale.cols }, () => ({ s: ' ' }))
  const gaps = scale.gaps()
  const inGap = (x) => gaps.some(([g0, g1]) => x >= g0 && x < g1)
  const fill = (a, b, run) => {
    if (b < scale.from || a > scale.to) return
    for (let x = scale.x(Math.max(a, scale.from)); x <= scale.x(Math.min(b, scale.to)); x++) if (!inGap(x)) cells[x] = run
  }
  for (const [a, b] of spans) fill(a, b, { s: '─', fg: COLORS.rule })
  for (const it of its) {
    if (!it.duration || it.duration < scale.step) continue
    const hue = colour.colourOf(colour.valueOf(it))
    fill(it.time, it.time + it.duration, hue && hue !== COLORS.dim ? { s: '─', fg: hue } : { s: '─', d: true })
  }
  strip(scale, its, { value: (it) => colour.valueOf(it), colour, max, time: (it) => it.time }).forEach((run, x) => {
    if (run.s !== ' ') cells[x] = run
  })
  const bad = new Map()
  for (const it of its) {
    const x = scale.binOf(it.time)
    if (x < 0) continue
    const [n, failed] = bad.get(x) || [0, 0]
    bad.set(x, [n + 1, failed + (it.outcome && it.outcome !== 'ok' ? 1 : 0)])
  }
  for (const [x, [n, failed]] of bad) if (failed * 2 >= n && failed) cells[x] = { s: '×' }
  return cells
}

function drawLanes(d, scale, gutter, room) {
  const by = {}
  for (const it of items) (by[it.session] = by[it.session] || []).push(it)
  const lanes = laneRows(room)
  const groups = lanes.map((l) => (l.session ? by[l.session.id] || [] : l.folded ? l.ss.flatMap((s) => by[s.id] || []) : []))
  const max = maxBin(scale, groups, (it) => it.time)
  lanes.forEach((l, i) => {
    const r = d.row()
    if (l.run) {
      // a run's name whole across the row, which holds no lane; cut to the names' column where it is folded to one
      const words = `${runName(l.run.id)} · ${l.run.team}`
      r.add(l.folded ? '▸' : '▾', {}, { on: () => folded.set(l.run.id, !l.folded), tip: l.folded ? 'show its sessions' : 'fold its sessions into one lane' })
      r.gap(1).add(words, { b: true }, { on: () => scope.set(`r:${l.run.id}`), tip: `${words}: show this run alone`, max: l.folded ? gutter - 4 : d.cols - 2 })
    } else {
      r.gap(2).add(l.guide, { fg: COLORS.rule })
      r.add(names[l.session.id], {}, { on: () => scope.set(`s:${l.session.id}`), tip: `${names[l.session.id]}: show this session and its subagents alone`, max: gutter - 4 - width(l.guide) })
    }
    r.at(gutter)
    if (l.session || l.folded) {
      const x0 = r.x
      const spans = l.session ? [[l.session.start, l.session.end]] : l.ss.map((s) => [s.start, s.end])
      r.runsOf(lane(scale, groups[i], spans, max))
      // a click on a lane opens the message or call nearest that time in it
      r.hits.push({ x0, x1: x0 + scale.cols, tip: '─ running · × failed · a click opens the message or call nearest that time', on: (x) => {
        const t = scale.t(x)
        const near = groups[i].filter((it) => range.has(it.time) && Math.abs(it.time - t) <= scale.step * 3).sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t))[0]
        if (near) reveal(near.ref)
      } })
    }
    r.end()
  })
}

// ------------------------------------------------------------------------------------------------ the view

draw((d) => {
  // the top row: the search, the sessions menu, Color by with its chips, Reset at R
  colour.draw(d, (r) => {
    q.add(r).gap()
    scope.add(r).gap()
  })
  if (!data) {
    d.row().add('◌ reading the sessions', { d: true }).end()
    return
  }
  // the subtitle: what the menu and the search keep
  d.sub(plural(new Set(data.scope.map((id) => S[id].run)).size, 'run'), plural(data.scope.length, 'session'), plural(data.calls.length, 'call'), plural(data.messages.length, 'message'))
  // the sessions' names in a column at the left, the time across the rest: the strip, the lanes and the axis share it
  const gutter = Math.max(14, Math.min(Math.floor(d.cols / 4), 2 + Math.max(...data.runs.map((r) => 2 + width(`${runName(r.id)} · ${r.team}`)), ...data.sessions.map((s) => 2 + 2 * s.depth + width(names[s.id] || '')))))
  range.draw(d, { gutter })
  const scale = range.scale(d.cols - gutter)
  // the lanes take what the list leaves them: the list keeps a third of the rows, at least eight
  drawLanes(d, scale, gutter, d.left - 2 - Math.max(8, Math.round(d.rows / 3)))
  // the axis, with the key of the lanes' own marks in the names' column, as in the browser
  axis(d, scale, { gutter, gap: 8, legend: [{ s: '─', fg: COLORS.rule }, { s: ' running  ', d: true }, { s: '×' }, { s: ' failed', d: true }] })
  d.blank()

  // the messages and calls in the range, in time order: each row its time, its session, its tool or kind, its first
  // line, and for a call how long it took, a failed one saying so after a `×`. Runs that follow one another each start
  // with their name as a heading; runs that overlap name theirs in each row
  const shown = items.filter((it) => range.has(it.time))
  const runOf = (it) => S[it.session].run
  const runs = new Set(shown.map(runOf))
  const overlap = shown.filter((it, i) => i && runOf(it) !== runOf(shown[i - 1])).length > runs.size - 1
  const who = (it) => (overlap ? `${runName(runOf(it))} · ${names[it.session]}` : names[it.session])
  const listed = []
  for (const it of shown) {
    if (!overlap && runs.size > 1 && (!listed.length || runOf(listed[listed.length - 1]) !== runOf(it))) {
      const run = data.runs.find((r) => r.id === runOf(it))
      listed.push({ heading: `${runName(run.id)} · ${run.team}` })
    }
    listed.push(it)
  }
  const end = (it) => `${it.outcome && it.outcome !== 'ok' ? `× ${it.outcome}  ` : ''}${it.tool ? secs(it.duration) : ''}`
  // the columns' widths from every row the fetch kept, so they stay put as the range moves; in a panel under 72 cells
  // the tool or kind stands before the first line and a failed call's `×` before both, and how long a call took is
  // left to its details, so the first line keeps its room
  const narrow = d.cols < 72
  const whoW = Math.min(narrow ? 10 : 24, Math.max(4, ...items.map((it) => width(who(it)))))
  const endW = Math.max(5, ...items.map((it) => width(end(it))))
  const cols = narrow
    ? columns([{ w: 8 }, { w: whoW }, { grow: true }], d.cols - 6)
    : columns([{ w: 8 }, { w: whoW }, { w: 9 }, { grow: true }, { w: endW, align: 'right' }], d.cols - 6)
  const textW = narrow ? cols.widths[2] : cols.widths[3]
  const failed = (it) => it.outcome && it.outcome !== 'ok'
  rows.draw(d, {
    items: listed,
    colour,
    empty: 'no message or call',
    row: (it, r) => narrow
      ? cols.cells(r, [hms(it.time), who(it), `${failed(it) ? '× ' : ''}${it.tool || KIND[it.kind]}  ${it.input ?? it.text}`], [{ d: true }, { d: true }, {}])
      : cols.cells(r, [hms(it.time), who(it), it.tool || KIND[it.kind], it.input ?? it.text, end(it)],
        [{ d: true }, { d: true }, {}, {}, failed(it) ? {} : { d: true }]),
    onOpen: (it) => readRecord(it.ref),
    ask: (it) => ({ ref: it.ref, text: it.input ?? it.text }),
    // a row opened in place: a message's whole text; a call's whole input where its row cut it, in the code color, then
    // what came back or the change an Edit made, its exit code and the session it spawned; then its place
    detail: (it, dd) => {
      const f = records.get(it.ref)
      if (!f) {
        dd.row().add('◌ reading it', { d: true }).end()
        return
      }
      const change = f.new != null ? [...(f.old ? f.old.split('\n').map((l) => `− ${l}`) : []), ...f.new.split('\n').map((l) => `+ ${l}`)].join('\n') : null
      const child = f.child && S[f.child]
      const asked = child && items.find((m) => m.session === child.id && m.kind === 'prompt')
      details(dd, {
        text: it.tool ? '' : f.text,
        maxRows: 10,
        blocks: it.tool ? [
          ...(width(f.input || '') > textW || /\n/.test(f.input || '') ? [{ text: f.input, code: true }] : []),
          { text: change ?? f.output ?? f.result },
        ] : [],
        facts: [['exit', f.exit], ...(narrow && it.tool ? [['took', secs(it.duration)], ['outcome', failed(it) ? it.outcome : '']] : [])],
        groups: child ? [{ title: 'Subagent', rows: [{ when: hms(child.start), words: names[child.id], text: asked ? asked.text : '', on: () => scope.set(`s:${child.id}`), tip: `show ${names[child.id]} and its subagents alone` }] }] : [],
        place: it.ref,
        ask: { ref: it.ref, text: it.input ?? it.text },
      })
    },
  })
})

load()
