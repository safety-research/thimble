// shell/dots.ts: which stream records light a tab's dot. The Canvas tab's dot is for a card made or deleted, never
// for the stream announcing a card again (a run, a check, a credit, a reworded takeaway).
import { describe, expect, it } from 'vitest'
import { tabOfEvent, tabSignals, writing } from '../../src/shell/dots'

const cell = (extra: Record<string, unknown>) => ({ type: 'cell', notebook: '5a59f4eb', cell: 'b387b6ee', kind: 'note', ...extra })

describe('tabOfEvent', () => {
  it('lights the canvas for a card made or deleted', () => {
    expect(tabOfEvent('cell', cell({ op: 'created' }))).toBe('canvas')
    expect(tabOfEvent('cell', cell({ kind: 'deleted', op: 'deleted' }))).toBe('canvas')
  })

  it('leaves the canvas dark for a card announced again, run, checked, credited or edited', () => {
    expect(tabOfEvent('cell', cell({}))).toBeNull()
    expect(tabOfEvent('cell', cell({ kind: 'verified' }))).toBeNull()
    for (const op of ['ran', 'credited', 'edited', 'moved', 'seen']) expect(tabOfEvent('cell', cell({ kind: 'ran', op }))).toBeNull()
  })

  it('still lights the report and the files for their own records', () => {
    expect(tabOfEvent('report', {})).toBe('report')
    expect(tabOfEvent('view', {})).toBe('files')
    expect(tabOfEvent('filter', { scope: 'canvas' })).toBe('canvas')
  })
})

describe('tabSignals', () => {
  const dots = { files: false, canvas: true, report: true }

  it('shows the spinner on the Report tab while a writer writes, in place of its dot', () => {
    expect(tabSignals(dots, true)).toEqual({ files: null, canvas: 'dot', report: 'spinner' })
    expect(tabSignals({ ...dots, report: false }, true).report).toBe('spinner')
  })

  it('shows the dot again once the writing ends, when something landed meanwhile', () => {
    expect(tabSignals(dots, false)).toEqual({ files: null, canvas: 'dot', report: 'dot' })
    expect(tabSignals({ ...dots, report: false }, false).report).toBeNull()
  })
})

describe('writing', () => {
  it('is true while a writer session runs, and only a writer', () => {
    expect(writing([{ role: 'writer', status: 'running' }])).toBe(true)
    expect(writing([{ role: 'writer', running: true }])).toBe(true)
    expect(writing([{ role: 'writer', status: 'done', running: false }, { role: 'orient', status: 'running' }])).toBe(false)
    expect(writing([{ role: 'writer', status: 'failed' }, { role: 'writer', status: 'stopped' }])).toBe(false)
  })
})
