import { describe, expect, it } from 'vitest'
import { changedExtensions, changedLocalViews, changedViews, extensionCalls, extensionDetails, extensionLine, extensionVersion, localViewDetails, localViewLine } from '../../src/shell/ExtensionsSettings'

const view = { name: 'Tally', shown: true, note: '', locked: false }
const row = { version: '', active: true, why: '', note: '', locked: false }
const loaded = [
  { ...row, name: 'a', on: true, views: [{ ...view, slug: 'tally', on: true }] },
  { ...row, name: 'b', on: false, views: [{ ...view, slug: 'tally', on: false }] },
]

describe('changedExtensions', () => {
  it('sends only the switches that moved', () => {
    expect(changedExtensions(loaded, { a: true, b: true })).toEqual({ b: true })
  })
})

describe('extensionCalls', () => {
  it('adds an extension thimble ships when its switch goes on, and switches the others', () => {
    const swarmOrient = { ...row, name: 'swarm-orient', on: false, views: [], addable: true }
    expect(extensionCalls([...loaded, swarmOrient], { a: false, b: true, 'swarm-orient': true })).toEqual([['a', 'off'], ['b', 'on'], ['swarm-orient', 'add']])
    expect(extensionCalls([swarmOrient], { 'swarm-orient': false })).toEqual([])
  })
})

describe('changedViews', () => {
  it('sends only the view switches that moved, by extension and view', () => {
    expect(changedViews(loaded, { 'a/tally': true, 'b/tally': true })).toEqual([['b', 'tally', true]])
  })
})

describe('changedLocalViews', () => {
  it("sends only the switches of the workspace's own views that moved", () => {
    const local = [
      { slug: 'timeline', name: 'Timeline', file_viewer: false, on: true },
      { slug: 'pages', name: 'Pages', file_viewer: true, on: false },
    ]
    expect(changedLocalViews(local, { timeline: false, pages: false })).toEqual([['timeline', false]])
  })
})

describe('an extension row', () => {
  const ext = { ...row, name: 'tally', on: true, views: [], description: 'Who did each task.', parts: ['Tally view'], consent: 'critic: network.' }
  it('shows its description under its name, and what it gives and runs under only in its details', () => {
    expect(extensionLine(ext)).toBe(ext.description)
    const keys = extensionDetails({ ...ext, sandboxed: true }).map(([k]) => k)
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(3)
    expect(extensionDetails({ ...ext, sandboxed: null })).toHaveLength(2)
  })
  it('shows why it does not run in place of its description, which moves into its details', () => {
    const broken = { ...ext, note: 'its manifest has an unknown key', locked: true }
    expect(extensionLine(broken)).toBe(broken.note)
    expect(extensionDetails(broken).some(([, words]) => words === ext.description)).toBe(true)
  })
  it('reads as simply off when thimble ships it and it is not added', () => {
    const swarmOrient = { ...ext, on: false, addable: true, builtin: true, note: 'Not added', why: 'not added' }
    expect(extensionLine(swarmOrient)).toBe(ext.description)
  })
  it('shows a version only for an extension thimble does not ship', () => {
    expect(extensionVersion({ ...ext, version: '1.2.0', builtin: false })).toBe('1.2.0')
    expect(extensionVersion({ ...ext, version: '0.4.0', builtin: true })).toBe('')
  })
  it('names in its details what turning it on adds with it, while it is not added', () => {
    const swarmOrient = { ...ext, on: false, addable: true, builtin: true, needs: ['tally-base'] }
    expect(extensionDetails(swarmOrient).some(([, words]) => words.includes('tally-base'))).toBe(true)
    expect(extensionDetails({ ...swarmOrient, addable: false }).some(([, words]) => words.includes('tally-base'))).toBe(false)
  })
})

describe('a view built here', () => {
  const v = { slug: 'pages', name: 'Pages', description: 'Each page with its edits.', file_viewer: false, on: true }
  it('shows what it shows under its name, or that a file viewer opens in the File browser with its description in its details', () => {
    expect(localViewLine(v)).toBe(v.description)
    expect(localViewDetails(v)).toEqual([])
    expect(localViewLine({ ...v, file_viewer: true })).not.toBe(v.description)
    expect(localViewDetails({ ...v, file_viewer: true })).toEqual([['', v.description]])
    expect(localViewLine({ ...v, description: undefined })).toBe('')
  })
})
