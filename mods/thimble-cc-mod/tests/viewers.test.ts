// The worked examples of views (viewers/<name>/): each spec and its reader's rows pass the checks, show the method
// (problems reported, derived fields declared, an overview, a zoom, filters and details), and draw within the panel at
// 70 and 110 columns in every state a reviewer looks at. `claude plugin test mods/thimble-cc-mod`.
import { expect, test } from 'claude-code/testing'

import { lineWidth } from '../hooks/draw'
import { initialState, reduce, tabRows, viewLayout } from '../hooks/viewdraw'
import type { ViewState } from '../hooks/viewdraw'
import { validateData, validateSpec } from '../hooks/viewspec'
import type { ViewData, ViewSpec } from '../hooks/viewspec'
import { VIEWERS } from './view-examples'

const text = (lines: { s: string }[][]) => lines.map(l => l.map(s => s.s).join('')).join('\n')
const HEX = /\b(?=\d*[a-f])[0-9a-f]{8,}\b/

/** Each tab as it opens and with its first row selected, then with every label on, and with the first label's filter. */
function states(spec: ViewSpec, data: ViewData, cols: number, rows: number): ViewState[] {
  const labels = (data.labels ?? []).map(l => l.id)
  const first = data.labels?.[0]
  const bases: Partial<ViewState>[] = [{}, { labelsOn: labels }, ...(first ? [{ labelsOn: [first.id], labelFilter: { id: first.id, value: first.values[0]! } }] : [])]
  return bases.flatMap(b =>
    spec.tabs.flatMap((_, i) => {
      const st = { ...initialState(), ...b, tab: i }
      const sel = viewLayout(spec, data, st, cols, rows).meta.order[0]
      return sel ? [st, reduce(spec, data, st, { op: 'select', ...sel }).state] : [st]
    }),
  )
}

test('each worked example passes the spec and rows checks, with no notes', () => {
  for (const [name, ex] of Object.entries(VIEWERS)) {
    expect([name, validateSpec(ex.spec)]).toEqual([name, []])
    const d = validateData(ex.spec, ex.data)
    expect([name, d.problems, d.notes]).toEqual([name, [], []])
  }
})

test('each worked example shows the method: problems reported, derived fields declared, overview, zoom, filters, details', () => {
  for (const [name, ex] of Object.entries(VIEWERS)) {
    const { spec, data } = ex
    // the sample's torn line is reported, and the files read are counted
    expect([name, data.problems?.length, (data.files ?? 0) > 0]).toEqual([name, 1, true])
    // fields the reader made say so
    const derived = spec.collections.flatMap(c => c.fields.filter(f => f.derived))
    expect(derived.length).toBeGreaterThan(5)
    // every tab an overview and what a click on it narrows, some overview a time axis to zoom on, filters on every tab
    // of more than a few rows, and every collection's detail
    for (const t of spec.tabs) expect([name, t.name, Boolean(t.overview), Boolean(t.zoom)]).toEqual([name, t.name, true, true])
    expect([name, spec.tabs.some(t => t.overview?.kind === 'lanes' || t.overview?.kind === 'histogram')]).toEqual([name, true])
    for (const t of spec.tabs) if ((data.collections[t.collection]?.length ?? 0) > 10) expect([name, t.name, t.filter.fields.length > 0]).toEqual([name, t.name, true])
    for (const c of spec.collections) expect([name, c.name, Boolean(c.detail)]).toEqual([name, c.name, true])
    // the units' stories: some detail lists another collection's rows that name the row
    expect([name, spec.collections.some(c => (c.detail?.related ?? []).length > 0)]).toEqual([name, true])
  }
})

test('each worked example draws within the panel at 70 and 110 columns, in every state, with no hex id', () => {
  for (const [name, ex] of Object.entries(VIEWERS)) {
    for (const [cols, rows] of [[70, 48], [110, 52]] as const) {
      for (const st of states(ex.spec, ex.data, cols, rows)) {
        const lay = viewLayout(ex.spec, ex.data, st, cols, rows)
        const wide = lay.lines.map(lineWidth).filter(w => w > cols)
        expect([name, cols, st.tab, wide]).toEqual([name, cols, st.tab, []])
        expect(lay.lines.length).toBeLessThanOrEqual(rows)
        for (const h of lay.hits) expect(h.x1).toBeLessThanOrEqual(cols)
        expect([name, cols, st.tab, HEX.exec(text(lay.lines))?.[0] ?? null]).toEqual([name, cols, st.tab, null])
      }
    }
  }
})

test('a label marks a unit when it marks any record the unit gathers, as thimble keeps units', () => {
  const filtered = (name: string, tab: number, label: string) => {
    const { spec, data } = VIEWERS[name]!
    const l = data.labels!.find(x => x.name === label)!
    return tabRows(spec, data, { ...initialState(), tab, labelsOn: [l.id], labelFilter: { id: l.id, value: l.values[0]! } }).rows.length
  }
  expect(filtered('repository', 0, 'Clock change')).toBe(6)
  expect(filtered('repository', 1, 'Clock change')).toBe(6)
  expect(filtered('repository', 3, 'Clock change')).toBe(8)
  expect(filtered('linked-sessions', 0, 'Test runs')).toBe(66)
  expect(filtered('linked-sessions', 2, 'Test runs')).toBe(15)
  expect(filtered('timeline', 0, 'Charged twice')).toBe(12)
})

test('hierarchy: group headings after a blank line, items with their glyph hanging, secondary text dim on the title\'s axis; no bold', () => {
  const repo = VIEWERS.repository!
  const lay = viewLayout(repo.spec, repo.data, initialState(), 110, 52)
  const lines = lay.lines.map(l => l.map(s => s.s).join(''))
  // no usage hint under the overview
  expect(lines.some(l => l.startsWith('↑'))).toBe(false)
  // nothing is new in a view as it opens: no bold anywhere
  expect(lay.lines.some(l => l.some(s => s.b))).toBe(false)
  // a group's heading at A0: its name, its count dim, a blank line above it but at the top; no marker
  const r2 = lines.findIndex(l => /^r2 {2}\d+$/.test(l))
  expect(r2).toBeGreaterThan(0)
  expect(lines[r2 - 1]!.trim()).toBe('')
  // an item: its state as a coloured glyph hanging at A0, its title at A2, regular
  const item = lay.lines[r2 + 1]!
  expect(item.map(s => s.s).join('')).toMatch(/^● Make/)
  expect(item.find(s => s.s === '●')?.fg).toMatch(/^#/)
  // its secondary line: at A2 under the title, dim
  expect(lines[r2 + 2]).toMatch(/^ {2}#9 by dune/)
  expect(lay.lines[r2 + 2]!.find(s => s.s.startsWith('#9'))?.fg).toBe('inactive')
  // a flagged pull request: its glyph and its flag's tag in the error colour, with no band behind it
  const flagged = lay.lines.find(l => l.some(s => s.s === '×'))!
  expect(flagged.find(s => s.s === '×')?.fg).toBe('error')
  expect(lay.lines.some(l => l.some(s => s.s.includes('merged over a change request') && s.fg === 'error' && !s.bg))).toBe(true)
})

test('a where of null keeps the rows with a value, or those without', () => {
  const { spec, data } = VIEWERS.timeline!
  const all = data.collections.events!.length
  const withInc = tabRows(spec, data, { ...initialState(), tab: 1 }).rows.length
  expect(withInc).toBe(134)
  const s = { ...spec, tabs: [{ ...spec.tabs[1]!, where: { field: 'incident', is: null } }] }
  expect(tabRows(s, data, initialState()).rows.length).toBe(all - withInc)
})

test('the ports draw what thimble draws: flagged calls, lanes grouped by run with their counts, stacked runs', () => {
  const ls = VIEWERS['linked-sessions']!
  const lanes = text(viewLayout(ls.spec, ls.data, initialState(), 110, 52).lines)
  // a heading per run with its calls and errors, each session's beside its name under tree lines
  expect(/r1 · nested team\s+149\s+15/.test(lanes)).toBe(true)
  expect(/├ client-port\s+35\s+3 /.test(lanes)).toBe(true)
  // errors and denials flagged in the lanes and counted under them
  expect(lanes.includes('× error 31') && lanes.includes('! denied 7')).toBe(true)
  // the strip stands on the lanes' axis: its bars start in the column the lanes' axis starts
  const strip = lanes.split('\n').find(l => l.includes('┤'))!
  const axis = lanes.split('\n').find(l => l.includes('└─'))!
  expect(strip.indexOf('┤') + 2).toBe(axis.indexOf('└'))
  const repo = VIEWERS.repository!
  const pulls = text(viewLayout(repo.spec, repo.data, initialState(), 110, 52).lines)
  // the runs panel: each run's bar stacked by state, merged of opened at its end
  expect(/r1 +█+ +7 of 8/.test(pulls)).toBe(true)
  // the forge's line under each title, short, its flags as chips after it
  expect(pulls.includes('#15 by elm · open for 1h 53m · closes #8   waiting for approvals')).toBe(true)
  // a flagged value takes the error colour in a table
  const calls = viewLayout(ls.spec, ls.data, { ...initialState(), tab: 1, facets: { '1.outcome': ['error'] } }, 110, 52)
  expect(calls.lines.some(l => l.some(s => s.s.trim() === 'error' && s.fg === 'error'))).toBe(true)
})
