// Views (views/SPEC.md): the spec's and the rows' checks, every view drawn within the panel's width, the analyst's
// acts, and the view panel driven through its Client. `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { lineWidth } from '../hooks/draw'
import { HIT_ASK, HIT_MENU, HIT_ROW, RELATED_ROWS, cutMiddle, detail, dur, fitWidths, initialState, keptColumns, namesNumber, overviewCaption, packHits, placeLabel, reduce, tabRows, viewLayout } from '../hooks/viewdraw'
import type { ViewState } from '../hooks/viewdraw'
import { validateData, validateSpec } from '../hooks/viewspec'
import type { ViewData, ViewSpec } from '../hooks/viewspec'
import { VIEWERS } from './view-examples'
import { largeView } from './view-large'
import { wikiView } from './view-wiki'
import { REPOSITORY, SESSIONS, TIMELINE } from './view-fixtures'

const EXAMPLES = { timeline: TIMELINE, 'linked-sessions': SESSIONS, repository: REPOSITORY }
const text = (lines: { s: string }[][]) => lines.map(l => l.map(s => s.s).join('')).join('\n')
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

// ------------------------------------------------------------------------------------------------ checks

test('the three worked examples validate, spec and rows', () => {
  for (const [name, ex] of Object.entries(EXAMPLES)) {
    expect([name, validateSpec(ex.spec)]).toEqual([name, []])
    expect([name, validateData(ex.spec, ex.data).problems]).toEqual([name, []])
  }
})

test('a spec\'s problems are named by their place, all at once', () => {
  const s = clone(SESSIONS.spec) as unknown as Record<string, unknown> & ViewSpec
  s.slug = 'Linked Sessions'
  s.tabs[1]!.body[0] = { kind: 'table', columns: [{ field: 'nope' }, { field: 'tool', show: 'bar' }] }
  s.tabs[0]!.body[0] = { kind: 'lanes', lane: 'run', time: 'time', lanes: { collection: 'sessions' } }
  delete (s.tabs[2] as Partial<typeof s.tabs[2]>).overview
  ;(s.tabs[2] as unknown as Record<string, unknown>).facets = ['run']
  s.collections[2]!.fields.push({ name: 'guess', type: 'category', derived: 'computed' })
  s.collections[2]!.fields.push({ name: 'when', type: 'date' as never })
  s.collections[1]!.detail!.related![0]!.via = 'kind'
  const ps = validateSpec(s)
  expect(ps).toContain('slug: lower case letters, digits and dashes')
  expect(ps).toContain('tabs[1].body[0].columns[0].field: nope is not a declared field of calls')
  expect(ps).toContain('tabs[1].body[0].columns[1].field: tool is category; this needs number or duration')
  expect(ps.some(p => p.startsWith('tabs[2].overview: required'))).toBe(true)
  expect(ps.some(p => p.startsWith('tabs[2].facets: moved'))).toBe(true)
  expect(ps).toContain('tabs[0].body[0].lane: run must link to sessions (its field\'s link)')
  expect(ps).toContain('collections[2].fields[14]: a derived field says where it comes from (from) and how (how)')
  expect(ps.some(p => p.startsWith('collections[2].fields[15].type: one of text, category'))).toBe(true)
  expect(ps).toContain('collections[1].detail.related[0].via: kind must link to sessions')
  expect(validateSpec([])).toEqual(['the spec is not a JSON object'])
})

test('rows: a missing collection, keys that repeat and values of the wrong type fail; hex titles and dangling links are notes', () => {
  const d = clone(TIMELINE.data) as ViewData
  d.collections.events![1]!.ref = d.collections.events![0]!.ref!
  d.collections.events![2]!.took = 'soon'
  expect(validateData(TIMELINE.spec, d).problems).toEqual([
    `collection events: ref is not unique (${String(d.collections.events![0]!.ref)} repeat)`,
    'collection events: 1 values of took are not duration (such as "soon")',
  ])
  expect(validateData(TIMELINE.spec, { collections: {} }).problems).toEqual(['collection events: no rows (rows.json collections.events is missing)'])
  const s = clone(SESSIONS.data) as ViewData
  for (const r of s.collections.sessions!) r.name = String(r.id)
  s.collections.calls![0]!.session = 'gone'
  const notes = validateData(SESSIONS.spec, s).notes
  expect(notes.some(n => n.startsWith('collection sessions: its title name reads as a hex id'))).toBe(true)
  expect(notes).toContain('collection calls: 1 values of session name no row of sessions')
})

// ------------------------------------------------------------------------------------------------ drawing

/** Each tab of a view, as it opens and with its first row selected. */
function states(spec: ViewSpec, data: ViewData, cols: number, rows: number): ViewState[] {
  return spec.tabs.flatMap((_, i) => {
    const st = { ...initialState(), tab: i }
    const first = viewLayout(spec, data, st, cols, rows).meta.order[0]
    return first ? [st, reduce(spec, data, st, { op: 'select', ...first }).state] : [st]
  })
}

test('every view fits the panel: no line wider than it, no more lines than its rows, at any width', () => {
  for (const [name, ex] of Object.entries(EXAMPLES)) {
    for (const [cols, rows] of [[60, 30], [80, 40], [94, 46], [118, 50]] as const) {
      for (const st of states(ex.spec, ex.data, cols, rows)) {
        const lay = viewLayout(ex.spec, ex.data, st, cols, rows)
        const wide = lay.lines.map(lineWidth).filter(w => w > cols)
        expect([name, cols, st.tab, wide]).toEqual([name, cols, st.tab, []])
        expect(lay.lines.length).toBeLessThanOrEqual(rows)
        for (const h of lay.hits) expect(h.x1).toBeLessThanOrEqual(cols)
      }
    }
  }
})

test('the header is one line; one filter row whose field opens its values; no hex id anywhere', () => {
  const lay = viewLayout(SESSIONS.spec, SESSIONS.data, initialState(), 94, 46)
  const t = text(lay.lines)
  expect(t.split('\n')[0]).toMatch(/^Linked sessions {2}3 runs · 17 sessions · 90 calls +1 unreadable line {2}20 files ›$/)
  expect(t).toMatch(/^Sessions {2}Calls {2}Team/m)
  expect(t.split('\n')[2]).toMatch(/^search {2}filter {2}run · tool · .*labels +\d+ calls$/)
  expect(t).not.toMatch(/^tool +\w+ \d+ +\w+ \d+/m)
  const open = reduce(SESSIONS.spec, SESSIONS.data, initialState(), lay.hits.find(h => h.act.op === 'field' && h.act.field === 'tool')!.act).state
  expect(text(viewLayout(SESSIONS.spec, SESSIONS.data, open, 94, 46).lines)).toMatch(/^tool +(● )?\w+ \d+ +(● )?\w+ \d+/m)
  const about = reduce(SESSIONS.spec, SESSIONS.data, initialState(), lay.hits.find(h => h.act.op === 'panel' && h.act.p === 'about')!.act).state
  expect(text(viewLayout(SESSIONS.spec, SESSIONS.data, about, 94, 46).lines)).toMatch(/20 files read[\s\S]*Fields the reader made/)
  expect(t).toMatch(/├ client-port · r1/)
  expect(t).not.toMatch(/\b[0-9a-f]{8}\b/)
  const sel = reduce(SESSIONS.spec, SESSIONS.data, initialState(), { op: 'select', c: 'sessions', k: 'a07a4da7' }).state
  const d = text(viewLayout(SESSIONS.spec, SESSIONS.data, sel, 94, 46).lines)
  expect(d).toMatch(/client-port · r1 +↗ line 1 {2}\?/)
  expect(d).toMatch(/parent +lead · r1/)
  expect(d).not.toMatch(/\b[0-9a-f]{8}\b/)
})

test('lanes nest each subagent under the session that spawned it; a mark selects its call', () => {
  const lay = viewLayout(SESSIONS.spec, SESSIONS.data, initialState(), 94, 46)
  const lines = text(lay.lines).split('\n')
  const lead = lines.findIndex(l => l.startsWith('lead · r1'))
  // tree lines: a child under its parent, the last child closing the branch
  expect(lines[lead + 1]).toMatch(/^├ survey/)
  expect(lines[lead + 3]).toMatch(/^│ ├ pagination/)
  expect(lines[lead + 4]).toMatch(/^│ └ auth-headers/)
  const mark = lay.hits.find(h => h.act.op === 'select' && h.act.c === 'calls')
  expect(mark?.cite?.ref).toMatch(/#L\d+$/)
  const lane = lay.hits.find(h => h.act.op === 'select' && h.act.c === 'sessions' && h.row)
  expect(lane).toBeDefined()
})

test('a table sorts by a column, groups fold, and a bar column draws bars', () => {
  const st = { ...initialState(), tab: 1 }
  let lay = viewLayout(REPOSITORY.spec, REPOSITORY.data, st, 94, 46)
  expect(text(lay.lines)).toMatch(/# ▲/)
  const sortHit = lay.hits.find(h => h.act.op === 'sort' && h.act.field === 'title')!
  const sorted = reduce(REPOSITORY.spec, REPOSITORY.data, st, sortHit.act).state
  lay = viewLayout(REPOSITORY.spec, REPOSITORY.data, sorted, 94, 46)
  expect(text(lay.lines)).toMatch(/title ▲/)
  // a group's heading: its name and its count, its ● in the group's hue (the tab's colour field), no marker
  expect(text(lay.lines)).toMatch(/^● fixed {2}28$/m)
  const folded = reduce(REPOSITORY.spec, REPOSITORY.data, sorted, { op: 'group', g: 'fixed' }).state
  const f = text(viewLayout(REPOSITORY.spec, REPOSITORY.data, folded, 94, 46).lines)
  expect(f).toMatch(/^● open {2}8$/m)
  // folded: its heading, then "… N more"
  expect(f).toMatch(/^● fixed {2}28\n {2}… 28 more$/m)
  expect(text(viewLayout(REPOSITORY.spec, REPOSITORY.data, initialState(), 94, 46).lines)).toMatch(/\d m \d\d s █/)
})

test('facets, search and the label filter narrow the rows, each facet counted under the others', () => {
  const { spec, data } = TIMELINE
  let st = initialState()
  const all = tabRows(spec, data, st).rows.length
  st = reduce(spec, data, st, { op: 'facet', field: 'source', value: 'chat' }).state
  const chat = tabRows(spec, data, st)
  expect(chat.rows.every(r => r.source === 'chat')).toBe(true)
  expect(chat.facets.find(f => f.field === 'source')!.values.length).toBeGreaterThan(1)
  const t = text(viewLayout(spec, data, st, 94, 46).lines)
  expect(t).toMatch(new RegExp(`${chat.rows.length} of ${all} events$`, 'm'))
  // the filter on: "field value" on the selection background, which a click turns off
  expect(t).toMatch(/^source chat +clear all$/m)
  for (const ch of 'payments') st = reduce(spec, data, { ...st, typing: true }, { op: 'key', key: ch }).state
  expect(st.q).toBe('payments')
  expect(tabRows(spec, data, st).rows.every(r => /payments/i.test(JSON.stringify(r)))).toBe(true)
  st = reduce(spec, data, st, { op: 'clear' }).state
  expect(tabRows(spec, data, st).rows.length).toBe(all)
  st = reduce(spec, data, st, { op: 'labelValue', id: 'label-1', value: 'connections' }).state
  expect(st.labelsOn).toEqual(['label-1'])
  const marked = tabRows(spec, data, st).rows
  expect(marked.length).toBeGreaterThan(0)
  expect(marked.every(r => data.labels![0]!.marks[String(r.ref)] === 'connections')).toBe(true)
  const lay = viewLayout(spec, data, st, 94, 46)
  expect(text(lay.lines)).toMatch(/● Database connections/)
  // the label on is the tab's colour field: the rows it marks take its hue on their glyph, the others a dim ●
  const hue = data.labels![0]!.colours?.connections ?? lay.lines.flat().find(s => s.s === '● ')?.fg
  expect(lay.lines.some(l => l[0]?.s === '●' && l[0]?.fg === hue)).toBe(true)
  expect(lay.lines.some(l => l.some(s => s.s === '▍ '))).toBe(false)
})

test('keys step through the rows; a link is followed and ‹ goes back; ? and o ask the mod for a thread and a place', () => {
  const { spec, data } = REPOSITORY
  let st = initialState()
  let lay = viewLayout(spec, data, st, 94, 46)
  st = reduce(spec, data, st, { op: 'key', key: 'down' }, lay.meta).state
  expect(st.sel).toEqual(lay.meta.order[0]!)
  st = reduce(spec, data, st, { op: 'key', key: 'down' }, lay.meta).state
  expect(st.sel).toEqual(lay.meta.order[1]!)
  lay = viewLayout(spec, data, st, 94, 46)
  const follow = lay.hits.find(h => h.act.op === 'follow' && h.act.c === 'issues')!
  expect(follow).toBeDefined()
  const before = st.sel
  st = reduce(spec, data, st, follow.act).state
  expect(st.sel?.c).toBe('issues')
  expect(text(viewLayout(spec, data, st, 94, 46).lines)).toMatch(/‹ /)
  st = reduce(spec, data, st, { op: 'key', key: 'left' }, lay.meta).state
  expect(st.sel).toEqual(before)
  expect(reduce(spec, data, st, { op: 'key', key: '?' }).effect).toEqual({ ask: before! })
  expect(reduce(spec, data, st, { op: 'key', key: 'o' }).effect?.open?.ref).toMatch(/#L\d+$/)
  expect(reduce(spec, data, st, { op: 'key', key: 'tab' }).state.tab).toBe(1)
})

test('the header opens the unreadable lines and the derived fields under the view', () => {
  const { spec, data } = TIMELINE
  const lay = viewLayout(spec, data, initialState(), 94, 46)
  const hit = lay.hits.find(h => h.act.op === 'panel' && h.act.p === 'problems')!
  const st = reduce(spec, data, initialState(), hit.act).state
  const t = text(viewLayout(spec, data, st, 94, 46).lines)
  expect(t).toMatch(/1 unreadable lines/)
  expect(t).toMatch(/agents\.log line 38 {2}not a log line/)
  const d = text(viewLayout(spec, data, { ...st, panel: 'derived' }, 94, 46).lines)
  expect(d).toMatch(/service +computed/)
})

test('helpers: durations, a place named without a hex file name, widths shared by need', () => {
  expect([dur(4.2), dur(75), dur(3720), dur(90000)]).toEqual(['4.2 s', '1 m 15 s', '1 h 02 m', '1 d 1 h'])
  // rounded to the smaller unit first: never 60 s, 60 m or 24 h (18 Jun 17:15 to 2 Jul 16:46 is 13 d 23 h 31 m)
  expect([dur(9.97), dur(59.6), dur(119.7), dur(3599.6), dur(7170), dur(86399), dur(13 * 86400 + 23 * 3600 + 31 * 60), dur(-3599.6)]).toEqual(['10 s', '1 m 00 s', '2 m 00 s', '1 h 00 m', '2 h 00 m', '1 d 0 h', '14 d 0 h', '-1 h 00 m'])
  expect(placeLabel('runs/r1/36fe6b9d-6e6d-4582-aef9-c97a0fe8f576.jsonl#L4')).toBe('line 4')
  expect(placeLabel('runs/r1/subagents/agent-a07a4da7.jsonl#L4')).toBe('line 4')
  expect(placeLabel('runs/r1/events.jsonl#L4-L9')).toBe('events.jsonl lines 4-9')
  const ws = fitWidths([10, 40, 6], [6, 6, 6], 40)
  expect(ws.reduce((a, b) => a + b, 0)).toBe(36)
  expect(ws[1]).toBeGreaterThan(ws[0]! + 10)
  expect(ws[2]).toBe(6)
})

// ------------------------------------------------------------------------------------------------ narrow and large

const lineOf = (lines: string[], re: RegExp) => lines.find(l => re.test(l)) ?? ''

test('in a narrow panel a table keeps the columns that fit whole and leaves the rest to the detail', () => {
  // the panel at 120 columns is 49 wide: the layout gets 46
  const ls = VIEWERS['linked-sessions']!
  const calls = text(viewLayout(ls.spec, ls.data, { ...initialState(), tab: 1 }, 46, 44).lines).split('\n')
  expect(lineOf(calls, /^ +time ▲/)).toMatch(/^ +time ▲ {2}session +tool +duration$/)
  // times and durations whole: "1 m 02 s", "4 m 18 s", never "1 m …"
  expect(calls.some(l => /^● +1 m 02 s {2}lead · r\d +Task +4 m 18 s$/.test(l))).toBe(true)
  expect(calls.some(l => /\d …/.test(l))).toBe(false)
  const wide = text(viewLayout(ls.spec, ls.data, { ...initialState(), tab: 1 }, 110, 44).lines).split('\n')
  expect(lineOf(wide, /^ +time ▲/)).toMatch(/time ▲ +session +tool +input +duration +outcome$/)
  // no cell is a lone "…"
  const compare = text(viewLayout(ls.spec, ls.data, { ...initialState(), tab: 2 }, 46, 44).lines)
  expect(compare).not.toMatch(/ … /)
  expect(compare).toMatch(/run ▲ +calls +errors +denied$/m)
  const tl = VIEWERS.timeline!
  const events = text(viewLayout(tl.spec, tl.data, initialState(), 46, 44).lines).split('\n')
  expect(lineOf(events, /^ +time +source/)).not.toMatch(/…/)
  // rows under a group keep the columns, their glyph at A0: no indent under the heading
  expect(events.some(l => /^[●×!] \d\d:\d\d:\d\d {2}chat /.test(l))).toBe(true)
  // the long prose goes first, then the last column but the first and the row's name
  expect(keptColumns([9, 12, 9, 30, 8, 7], [9, 8, 9, 8, 8, 7], 44, -1, [false, false, false, true, false, false])).toEqual([0, 1, 2, 4])
  expect(keptColumns([9, 30], [9, 8], 44, -1, [false, true])).toEqual([0, 1])
})

test('a column\'s room goes where it shows the most cells whole, not to a column of short cells', () => {
  // a page column of names about 28 wide and a summary of mostly short cells: the names get their room
  const pages = [27, 28, 26, 28, 27, 30, 29]
  const summary = [1, 9, 4, 4, 1, 40, 1]
  const ws = fitWidths([12, 30, 40], [12, 8, 8], 12 + 30 + 20 + 4, [[12], pages, summary])
  expect(ws[1]).toBe(30)
  expect(ws.reduce((a, b) => a + b, 0)).toBe(62)
  expect(cutMiddle('wiki/CountyDataReferenceXYZ', 20)).toMatch(/^wiki\/County\S*…\S*XYZ$/)
  expect(cutMiddle('wiki/CountyDataReferenceXYZ', 20).length).toBe(20)
  expect(cutMiddle('AgentCountyPovertyIndex2015XQ', 16)).toMatch(/^AgentCou.*….*2015XQ$/)
  // a name the reader already cut keeps one ellipsis
  expect(cutMiddle('AgentCountyPov…ex2015XQ', 20).match(/…/g)!.length).toBe(1)
})

// ------------------------------------------------------------------------------------------------ what reviews sent back

test('tags read whole and without a band behind them: a cell keeps the tags that fit and counts the rest', () => {
  const { spec, data } = wikiView()
  const lines = text(viewLayout(spec, data, initialState(), 94, 48).lines).split('\n')
  // the column as wide as a tag drawn: "existed before" whole, never "existed befo…"
  expect(lines.some(l => l.trimEnd().endsWith('existed before'))).toBe(true)
  expect(lines.some(l => /existed be\S*…/.test(l))).toBe(false)
  // two tags too wide for the column: the first whole and the other counted
  expect(lines.some(l => /no name \+1$/.test(l.trimEnd()))).toBe(true)
  // at 64 columns the tags stay, as the row's state, while plain columns go first
  expect(lineOf(text(viewLayout(spec, data, initialState(), 64, 48).lines).split('\n'), /^ +page/)).toMatch(/notes *$/)
  // no background but the selection's in any example: tags, the detail's meta and the made fields' marks included
  for (const [name, ex] of [...Object.entries(VIEWERS), ['wiki', wikiView()] as const]) {
    ex.spec.tabs.forEach((t, tab) => {
      const first = tabRows(ex.spec, ex.data, { ...initialState(), tab }).rows[0]
      const c = ex.spec.collections.find(x => x.name === t.collection)!
      const states: ViewState[] = [{ ...initialState(), tab }, { ...initialState(), tab, panel: 'about' }]
      if (first) states.push({ ...initialState(), tab, sel: { c: c.name, k: String(first[c.key]) } })
      for (const st of states)
        for (const l of viewLayout(ex.spec, ex.data, st, 110, 52).lines) for (const x of l) if (x.bg && x.bg !== 'selectionBg') throw new Error(`${name} tab ${tab}: "${x.s}" on ${x.bg}`)
    })
  }
  // a list's tags after its text, three cells from it, in the text colour where the text is dim
  const repo = VIEWERS.repository!
  const second = viewLayout(repo.spec, repo.data, initialState(), 110, 52).lines.find(l => l.some(x => x.s === 'merged by its author'))!
  expect(second.map(x => x.s).join('')).toMatch(/closes #\d+ {3}merged by its author/)
  expect(second.find(x => x.s === 'merged by its author')?.fg).toBe(undefined)
})

test('a selected row\'s meta values follow their names; the columns its table leaves out show in its detail', () => {
  const { spec, data } = wikiView()
  const sel = { c: 'pages', k: String(data.collections.pages![0]!.id) }
  const wide = text(viewLayout(spec, data, { ...initialState(), sel }, 94, 60).lines).split('\n')
  expect(wide).toContain('  wiki probier · week first stored 06-14 to 06-20')
  const narrow = text(viewLayout(spec, data, { ...initialState(), sel }, 64, 60).lines).split('\n')
  const head = lineOf(narrow, /^ +page/)
  expect(head).not.toMatch(/named labels/)
  // left out of the table at 64 columns, so the detail shows it
  expect(narrow.some(l => /^ {2}named labels +342$/.test(l))).toBe(true)
  expect(wide.some(l => /^ {2}named labels +342/.test(l))).toBe(false)
})

test('numbers that count read with separators everywhere; numbers that name a thing read as written', () => {
  const { spec, data } = wikiView()
  const sel = { c: 'pages', k: String(data.collections.pages![0]!.id) }
  const t = text(detail(spec, data, { ...initialState(), sel }, 94).lines)
  const lines = text(viewLayout(spec, data, initialState(), 94, 48).lines).split('\n')
  // the revisions column: 2,327 and 1,013 alike
  expect(lines.some(l => /2,327 +342 /.test(l))).toBe(true)
  expect(lines.some(l => / 1,013 /.test(l))).toBe(true)
  // body bytes, a quantity, 13,403 and 1,011 alike; seq, a number that names a revision, as written
  expect(t).toMatch(/body bytes {2}13,403/)
  expect(t).toMatch(/^ {2}1004  Writer3Name +1,011$/m)
  expect(namesNumber({ name: 'seq', type: 'number' })).toBe(true)
  expect(namesNumber({ name: 'n', type: 'number', label: 'line' })).toBe(true)
  expect(namesNumber({ name: 'body_len', type: 'number' })).toBe(false)
  // bars without colours count with separators as the header does
  const plain = clone(spec)
  plain.tabs[0]!.overview = { kind: 'bars', field: 'wiki' }
  const big = wikiView(1200)
  const dse = big.data.collections.pages!.filter(r => r.wiki === 'dse').length
  expect(dse).toBeGreaterThan(999)
  expect(text(viewLayout(plain, big.data, initialState(), 94, 48).lines)).toMatch(new RegExp(`^dse +█+ +${dse.toLocaleString('en-US')}$`, 'm'))
})

test('the rule above a bars or strip overview names what it counts, in the words of the rows and the field\'s label', () => {
  const { spec, data } = wikiView()
  // under the rule, a dim title row names the overview
  const top = text(viewLayout(spec, data, initialState(), 94, 48).lines).split('\n')
  expect(top[2]).toMatch(/^─+$/)
  expect(top[3]).toBe('pages by week first stored')
  const pages = spec.collections[0]!
  expect(overviewCaption(spec, pages, { kind: 'bars', field: 'wiki', value: 'revs' })).toBe('revs by wiki')
  expect(overviewCaption(spec, pages, { kind: 'bars', field: 'wiki', value: 'revs', agg: 'mean' })).toBe('mean revs by wiki')
  expect(overviewCaption(spec, pages, { kind: 'histogram', time: 'first' })).toBe('pages by first')
  expect(overviewCaption(spec, pages, { kind: 'lanes', lane: 'wiki', time: 'first' })).toBe('')
  // a collection the header does not count is named by its own name
  expect(overviewCaption(spec, spec.collections[1]!, { kind: 'histogram', time: 'seq' })).toBe('revisions by seq')
})

test('a related section followed by another shows its first rows and opens whole on a click; the last shows all', () => {
  const { spec, data } = wikiView()
  const st = { ...initialState(), sel: { c: 'pages', k: String(data.collections.pages![0]!.id) } }
  const d = detail(spec, data, st, 94)
  const lines = text(d.lines).split('\n')
  const at = lines.indexOf('Labels  342')
  // the label, its 8 heaviest labels, then the rest counted, and the revisions in reach under them
  expect(lines[at + 2]).toMatch(/^ {2}Writer0Name +342$/)
  expect(lines[at + 2 + RELATED_ROWS]).toBe('  … 334 more')
  expect(lines[at + 4 + RELATED_ROWS]).toBe('Revisions  12')
  expect(lines.filter(l => /^ {2}\d{4}  Writer/.test(l))).toHaveLength(12)
  const more = d.hits.find(h => h.act.op === 'whole')!
  const open = reduce(spec, data, st, more.act).state
  const all = text(detail(spec, data, open, 94).lines).split('\n')
  expect(all.filter(l => /^ {2}Writer\d+Name +\d+$/.test(l))).toHaveLength(342)
  expect(all[all.indexOf('Revisions  12') - 2]).toBe('  fewer')
  // the same click again shortens it
  const fewer = detail(spec, data, open, 94).hits.find(h => h.act.op === 'whole')!
  expect(reduce(spec, data, open, fewer.act).state.open).toEqual([])
})

test('a strip\'s scale is as wide as its largest bin at the width the scale leaves it, never cut ("1,20…")', () => {
  // two clumps of 600 rows a bin apart at 86 bins and in one bin at 88: a scale sized at 86 bins for a strip of 88
  // was cut
  const t = (x: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + x * 1e9).toISOString()
  const rows = [0, 1, ...Array<number>(600).fill(0.0116), ...Array<number>(600).fill(0.0117)].map((x, i) => ({ k: `r${i}`, ref: `e.jsonl#L${i + 1}`, title: `event ${i}`, time: t(x) }))
  const spec = {
    version: 1, name: 'Events', slug: 'events', description: 'Events.', scope: ['e.jsonl'],
    collections: [{ name: 'events', one: 'one event', key: 'k', title: 'title', fields: [{ name: 'k', type: 'text' }, { name: 'ref', type: 'ref' }, { name: 'title', type: 'text' }, { name: 'time', type: 'time' }] }],
    tabs: [{ name: 'Events', collection: 'events', overview: { kind: 'histogram', time: 'time' }, zoom: 'a click on a bin zooms', filter: { fields: [] }, body: [{ kind: 'table', columns: [{ field: 'title' }, { field: 'time' }] }] }],
  } as unknown as ViewSpec
  const lines = text(viewLayout(spec, { collections: { events: rows } }, initialState(), 94, 40).lines).split('\n')
  // the strip's top line, under the rule and the title row that names it
  expect(lines[2]).toMatch(/^─+$/)
  expect(lines[3]).toBe('events by time')
  expect(lines[4]).toMatch(/^ *(601|1,200) ┤/)
})

test('the row\'s name takes its room first: nine in ten names whole before another column widens', () => {
  // a name column, two short columns and a long text column whose cells just past its floor would take the room
  const names = [22, 30, 34, 26, 31, 33, 28, 29, 32, 24]
  const cells = [names, [6], [6], Array<number>(8).fill(14)]
  expect(fitWidths([34, 6, 6, 40], [26, 6, 6, 12], 61, cells, 0)).toEqual([31, 6, 6, 12])
  // without the name to favour, the long column takes its share first
  expect(fitWidths([34, 6, 6, 40], [26, 6, 6, 12], 61, cells)).toEqual([29, 6, 6, 14])
  // a table too wide for its panel leaves its last plain columns to the detail before it cuts the typical page name
  const { spec, data } = wikiView()
  const at80 = text(viewLayout(spec, data, initialState(), 80, 30).lines).split('\n')
  expect(lineOf(at80, /^ +page/)).toMatch(/^ +page +wiki +revs ▼ +named labels +notes *$/)
  expect(at80.some(l => /^● AgentSequenceCountyRounds242 /.test(l))).toBe(true)
})

test('the filter row counts what the header counts, in its words; numbers of a thousand or more read alike', () => {
  const { spec, data } = largeView(3000, 300)
  const revs = data.collections.changes!.filter(r => r.kind === 'revision').length
  const dels = data.collections.changes!.filter(r => r.kind === 'deletion').length
  const n = (x: number) => x.toLocaleString('en-US')
  for (const tab of [0, 1]) {
    const lines = text(viewLayout(spec, data, { ...initialState(), tab }, 96, 46).lines).split('\n')
    expect(lines[0]).toContain(`300 lanes · ${n(revs)} revisions · ${n(dels)} deletions`)
    // the bundles a lane draws are not rows the header counts
    expect(lineOf(lines, /^search /)).toMatch(new RegExp(`${n(revs)} revisions · ${n(dels)} deletions$`))
  }
  const st = reduce(spec, data, { ...initialState(), tab: 1 }, { op: 'facet', field: 'kind', value: 'deletion' }).state
  expect(lineOf(text(viewLayout(spec, data, st, 96, 46).lines).split('\n'), /^search /)).toMatch(new RegExp(`0 of ${n(revs)} revisions · ${n(dels)} deletions$`))
  // a tab whose own where leaves out some of what the header counts says so
  const narrower = { ...spec, tabs: [{ ...spec.tabs[1]!, where: { field: 'summary', not: '*' } }] }
  const shown = data.collections.changes!.filter(r => r.kind === 'revision' && r.summary !== '*').length
  expect(lineOf(text(viewLayout(narrower, data, initialState(), 96, 46).lines).split('\n'), /^search /)).toMatch(new RegExp(`${n(shown)} of ${n(revs)} revisions · `))
  // a stat of rows another stat counted (errors among calls) is not counted again
  const ls = VIEWERS['linked-sessions']!
  expect(lineOf(text(viewLayout(ls.spec, ls.data, { ...initialState(), tab: 1 }, 96, 46).lines).split('\n'), /^search /)).toMatch(/ 316 calls$/)
})

test('a strip over a table shows its scale; a legend takes a second line rather than drop a value', () => {
  const { spec, data } = largeView(3000, 300)
  const rev = text(viewLayout(spec, data, { ...initialState(), tab: 1 }, 92, 46).lines).split('\n')
  expect(rev.some(l => /^ *\d[\d,]* ┤ [▁▂▃▄▅▆▇█]/.test(l))).toBe(true)
  expect(rev.some(l => /^ +0 ┤ /.test(l))).toBe(true)
  // five long values, over lanes whose names take the left of the strip: all five drawn
  const long = { ...spec, tabs: spec.tabs.map(t => ({ ...t, overview: { ...t.overview, color: 'summary' } })) } as ViewSpec
  const t = text(viewLayout(long, data, initialState(), 92, 46).lines)
  for (const v of ['*', 'Real edit', 'adding public data references and links', 'ref2', 'Relay test']) expect(t).toContain(`● ${v} `)
})

test('lanes: a long name cut in the middle, the name column wider, meta columns that squeeze the axis left out', () => {
  const { spec, data } = largeView(3000, 300)
  const lines = text(viewLayout(spec, data, initialState(), 92, 46).lines).split('\n')
  const lane = lineOf(lines, /^ {2}HealthSequence/)
  expect(lane).toMatch(/^ {2}HealthSequence\S*…\S*Mar08Live +\d /)
  const withName = { ...spec, tabs: [{ ...spec.tabs[0]!, body: [{ ...spec.tabs[0]!.body[0]!, lanes: { collection: 'lanes', label: 'name', group: 'label', meta: ['revs', 'title'] } }] }] } as ViewSpec
  const narrow = text(viewLayout(withName, data, initialState(), 92, 46).lines).split('\n')
  expect(lineOf(narrow, /^name /)).toMatch(/^name +revs$/)
  const count = lineOf(lines, /lanes$/)
  expect(count).toMatch(/^\d+ of 300 lanes$/)
})

test('the detail gives a value too long for half the panel a line of its own, whole', () => {
  const { spec, data } = largeView(3000, 300)
  const first = viewLayout(spec, data, { ...initialState(), tab: 1 }, 92, 46).meta.order[0]!
  const st = reduce(spec, data, { ...initialState(), tab: 1 }, { op: 'select', ...first }).state
  const lines = text(viewLayout(spec, data, st, 92, 46).lines).split('\n')
  const lane = lineOf(lines, /^ {2}lane /)
  expect(lane).toMatch(/^ {2}lane +AgentLabel\d+ on wiki\/\S+Live$/)
  // the short ones beside each other, in two columns; no value cut
  expect(lineOf(lines, /^ {2}by /)).toMatch(/^ {2}by +AgentLabel\d+ {2,}\S/)
  const fields = lines.slice(lines.findIndex(l => /^ {2}lane /.test(l)) - 1).filter(l => /^ {2}(page|by|lane|time|kind) /.test(l))
  expect(fields.length).toBeGreaterThanOrEqual(3)
  expect(fields.some(l => l.includes('…'))).toBe(false)
})

// ------------------------------------------------------------------------------------------------ the panel

const CWD = '/corpus/ops'
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, scroll: { bodyRows: 46 } } } as const
type M = Mounted<'terminal'>
type El = { type: string; props: Record<string, unknown>; children?: unknown[] }
const textOf = (x: unknown): string => (typeof x === 'string' ? x : ((x as El).children ?? []).map(textOf).join(''))
/** The panel's column inside its type area (the Box that insets it 1 cell from each edge). */
const column = (x: unknown): El => {
  const el = x as El
  return el.props?.paddingLeft === 1 && (el.children ?? []).length === 1 ? (el.children![0] as El) : el
}
/** The panel's view without its top row, the way (back, the breadcrumb, the threads tree). */
const viewOf = (x: unknown): El => ({ ...column(x), children: (column(x).children ?? []).filter(c => (c as El).props?.key !== 'way') })
/** The way's row as the terminal draws it: a plain Button as its label (no hotkey shows), a Text as its text. */
const wayText = (x: unknown): string => {
  const way = (column(x).children ?? []).find(c => (c as El).props?.key === 'way') as El | undefined
  return ((way?.children ?? []) as El[]).map(c => (c.type === 'Button' ? `${c.props.hotkey ? `${String(c.props.hotkey)}: ` : ''}${String(c.props.label)}` : textOf(c))).join('')
}
async function screen(ui: M, key: string): Promise<string[]> {
  const root = (await ui.drawn({ in: key })) as unknown as El
  return ((root.children ?? []) as El[]).map(c => textOf(c).trimEnd())
}

function world(on: On, views: Record<string, { spec: ViewSpec; data: ViewData }> = { timeline: TIMELINE }): { opened: string[]; threads: string[]; columns: (number | undefined)[] } {
  const w = { opened: [] as string[], threads: [] as string[], columns: [] as (number | undefined)[] }
  const files = new Map(
    Object.entries(views).flatMap(([slug, v]) => [
      [`${CWD}/.thimble-cc-mod/views/${slug}/view.json`, JSON.stringify(v.spec)],
      [`${CWD}/.thimble-cc-mod/views/${slug}/rows.json`, JSON.stringify(v.data)],
    ]),
  )
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  on('fs.stat', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/views') ? Object.keys(views).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) : [] }) as never)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    w.columns.push(e.columns)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('agent.spawn', ($, e) => {
    w.threads.push(String((e as { description?: string }).description ?? ''))
    return { value: { agentId: 'ag1' } } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

test('/thimble-view opens a view in the panel; a click on a facet narrows it, a click on a row shows its detail', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const r = await $.command.run({ command: 'thimble-view', args: 'timeline' } as never)
  expect((r as { text?: string }).text).toBe('opened Timeline')
  expect(w.opened).toEqual(['thimble'])
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  const IN = { in: 'view:timeline' }
  let lines = await screen(pane, 'view:timeline')
  expect(lines[0]).toMatch(/^Timeline +60 events/)
  // the filter row's field opens its values; a value narrows the rows
  const fy = lines.findIndex(l => l.startsWith('search'))
  await pane.pointer({ type: 'down', x: lines[fy]!.indexOf('source') + 1, y: fy, button: 'left', ...IN })
  await pane.unmount()
  const opened = (await $.ui.mount(PANE as never)) as unknown as M
  lines = await screen(opened, 'view:timeline')
  const y = lines.findIndex(l => l.startsWith('source'))
  const x = lines[y]!.indexOf('chat') + 1
  await opened.pointer({ type: 'down', x, y, button: 'left', ...IN })
  await opened.pointer({ type: 'up', x, y, button: 'left', ...IN })
  await opened.unmount()
  const again = (await $.ui.mount(PANE as never)) as unknown as M
  lines = await screen(again, 'view:timeline')
  expect(lines.join('\n')).toMatch(/\d+ of 60 events/)
  // a row of the list: its detail opens under the view
  const row = lines.findIndex(l => /^[●•×!] [A-Z].*\d\d May \d\d:\d\d/.test(l))
  await again.pointer({ type: 'down', x: 2, y: row, button: 'left', ...IN })
  await again.unmount()
  const third = (await $.ui.mount(PANE as never)) as unknown as M
  lines = await screen(third, 'view:timeline')
  expect(lines.some(l => /↗ .*line \d+ {2}\?$/.test(l))).toBe(true)
  await third.unmount()
})

test('the hits reach the Client packed: four numbers each, flags for a row, its "?" and a record', () => {
  const ex = VIEWERS['linked-sessions']!
  const lay = viewLayout(ex.spec, ex.data, initialState(), 118, 46)
  const p = packHits(lay.hits)
  expect(lay.hits.length).toBeGreaterThan(400)
  expect(p.hits.length).toBe(lay.hits.length * 4)
  lay.hits.forEach((h, i) => {
    const [y, x0, x1, f] = p.hits.slice(i * 4, i * 4 + 4)
    expect([y, x0, x1]).toEqual([h.y, h.x0, h.x1])
    expect(Boolean(f! & HIT_ROW)).toBe(Boolean(h.row))
    expect(Boolean(f! & HIT_ASK)).toBe(h.act.op === 'select' || h.act.op === 'follow')
    expect(Boolean(f! & HIT_MENU)).toBe(h.act.op === 'cite' || Boolean(h.cite))
  })
  // the same drawing, the same stamp; another drawing, another
  expect(packHits(viewLayout(ex.spec, ex.data, initialState(), 118, 46).hits).stamp).toBe(p.stamp)
  expect(packHits(viewLayout(ex.spec, ex.data, { ...initialState(), tab: 1 }, 118, 46).hits).stamp).not.toBe(p.stamp)
})

const NARROW = { ...PANE, viewport: { columns: 120, rows: 50 }, props: { bodyColumns: 120, scroll: { bodyRows: 46 } } } as const

test('a view of many lane marks draws at 120 columns, opening and after a row is deselected: its props stay far under the limit', async ($, on) => {
  // the worked example, whose 17 lanes of marks once took more than the 100,000 characters a Client's props may
  world(on, { 'linked-sessions': VIEWERS['linked-sessions']! })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-view', args: 'linked-sessions' } as never)
  const IN = { in: 'view:linked-sessions' }
  const size = async (ui: M) => JSON.stringify((await ui.find({ type: 'Client' }))!.props.props).length
  let pane = (await $.ui.mount(NARROW as never)) as unknown as M
  expect(await size(pane)).toBeLessThan(50000)
  let lines = await screen(pane, 'view:linked-sessions')
  expect(lines[0]).toMatch(/^Linked sessions/)
  // a session's row: selected, then deselected by a second click, the whole view drawn again each time
  const row = lines.findIndex(l => /^ {2}lead /.test(l))
  expect(row).toBeGreaterThan(0)
  const opening = lines.join('\n')
  for (let i = 0; i < 2; i++) {
    await pane.pointer({ type: 'down', x: 3, y: row, button: 'left', ...IN })
    await pane.unmount()
    pane = (await $.ui.mount(NARROW as never)) as unknown as M
    expect(await size(pane)).toBeLessThan(50000)
    lines = await screen(pane, 'view:linked-sessions')
    if (i === 0) expect(lines.join('\n')).not.toBe(opening)
  }
  expect(lines.join('\n')).toBe(opening)
  await pane.unmount()
})

test('a record a view opens is named as a record, and "‹ <view>" goes back to the view as it was', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-view', args: 'timeline' } as never)
  const IN = { in: 'view:timeline' }
  let pane = (await $.ui.mount(PANE as never)) as unknown as M
  let lines = await screen(pane, 'view:timeline')
  const row = lines.findIndex(l => /^[●•×!] [A-Z].*\d\d May \d\d:\d\d/.test(l))
  await pane.pointer({ type: 'down', x: 2, y: row, button: 'left', ...IN })
  await pane.unmount()
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  lines = await screen(pane, 'view:timeline')
  const y = lines.findIndex(l => /↗ .*line \d+ {2}\?$/.test(l))
  const title = lines[y]!.replace(/^[^A-Za-z]*/, '').replace(/\s+↗.*$/, '').trim()
  await pane.pointer({ type: 'down', x: lines[y]!.indexOf('↗') + 2, y, button: 'left', ...IN })
  await pane.unmount()
  // the place of the row, in the panel: the row's title, no word of a value to recompute; the path names it a record
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  const text = textOf(viewOf(await pane.drawn()))
  expect(text.startsWith(title.slice(0, 20))).toBe(true)
  expect(text).not.toContain('This citation shows no value to recompute.')
  // the breadcrumb: home › Timeline › record "…"; back leads to the view
  expect((await pane.find({ key: 'crumb-1' }))?.props.label).toBe('Timeline')
  expect(wayText(await pane.drawn())).toMatch(/^‹ back {2}home › Timeline › record "/)
  await pane.press({ key: 'nav-back' })
  await pane.unmount()
  // the view again, its row still selected
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  lines = await screen(pane, 'view:timeline')
  expect(lines[0]).toMatch(/^Timeline +60 events/)
  expect(lines.some(l => /↗ .*line \d+ {2}\?$/.test(l))).toBe(true)
  await pane.unmount()
  expect(w.opened.length).toBe(3)
})

test('in a narrow panel the breadcrumb fits its row: the crumbs between home and the record fold into "…"', async ($, on) => {
  world(on, { timeline: { spec: { ...TIMELINE.spec, name: 'Timeline of every source and incident' }, data: TIMELINE.data } })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-view', args: 'timeline' } as never)
  const IN = { in: 'view:timeline' }
  const P49 = { ...PANE, props: { bodyColumns: 49, scroll: { bodyRows: 46 } } }
  let pane = (await $.ui.mount(P49 as never)) as unknown as M
  let lines = await screen(pane, 'view:timeline')
  const row = lines.findIndex(l => /^[●•×!] [A-Z]/.test(l))
  await pane.pointer({ type: 'down', x: 3, y: row, button: 'left', ...IN })
  await pane.unmount()
  pane = (await $.ui.mount(P49 as never)) as unknown as M
  lines = await screen(pane, 'view:timeline')
  const y = lines.findIndex(l => /↗ /.test(l))
  await pane.pointer({ type: 'down', x: lines[y]!.indexOf('↗') + 2, y, button: 'left', ...IN })
  await pane.unmount()
  pane = (await $.ui.mount(P49 as never)) as unknown as M
  expect(await pane.find({ key: 'crumb-1' })).toBeUndefined()
  // back, main, the record and the threads button within the 48 columns the row has; back still leads to the view
  const way = wayText(await pane.drawn())
  expect(way).toMatch(/^‹ back {2}home › … › record ".*…threads$/)
  expect(way.length).toBeLessThanOrEqual(48)
  await pane.unmount()
  // at 96 columns the view's crumb shows, at most 34 columns of it
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect((await pane.find({ key: 'crumb-1' }))?.props.label).toMatch(/^Timeline of every source and i/)
  await pane.unmount()
})

test('a right-click on a row opens its record\'s menu; its "open" leads to the record with the way back', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-view', args: 'timeline' } as never)
  const IN = { in: 'view:timeline' }
  let pane = (await $.ui.mount(PANE as never)) as unknown as M
  const lines = await screen(pane, 'view:timeline')
  const row = lines.findIndex(l => /^[●•×!] [A-Z].*\d\d May \d\d:\d\d/.test(l))
  await pane.pointer({ type: 'down', x: 2, y: row, button: 'right', ...IN })
  await pane.unmount()
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await pane.find({ key: 'menu-open' })).toBeDefined()
  await pane.press({ key: 'menu-open' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect(wayText(await pane.drawn())).toMatch(/› record "/)
  expect(await pane.find({ key: 'nav-back' })).toBeDefined()
  expect((await pane.find({ key: 'crumb-1' }))?.props.label).toBe('Timeline')
  await pane.unmount()
})

test('the panel opens at 96 columns, or narrower so main keeps 70 beside it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const above = (columns: number) => ({ plugin: 'thimble-cc-mod', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns, rows: 50 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns, view: {} } })
  for (const columns of [200, 120, 110]) {
    const ui = (await $.ui.mount(above(columns) as never)) as unknown as M
    await ui.drawn()
    await ui.unmount()
    await $.command.run({ command: 'thimble-view', args: 'timeline' } as never)
  }
  expect(w.columns.slice(-3)).toEqual([96, 49, 39])
})
