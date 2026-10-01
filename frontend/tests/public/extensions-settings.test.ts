import { describe, expect, it } from 'vitest'
import { answeredRuns, asksToRun, changedExtensions, changedLocalViews, changedViews, extensionCalls } from '../../src/shell/ExtensionsSettings'

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
    const swarm = { ...row, name: 'swarm', on: false, views: [], addable: true }
    expect(extensionCalls([...loaded, swarm], { a: false, b: true, swarm: true })).toEqual([['a', 'off'], ['b', 'on'], ['swarm', 'add']])
    expect(extensionCalls([swarm], { swarm: false })).toEqual([])
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

describe('asksToRun', () => {
  const swarm = { ...row, name: 'swarm', on: false, views: [], orients: true }
  it('asks when a switch with orientation instructions goes on where an orientation ran', () => {
    expect(asksToRun(swarm, true, true)).toBe(true)
    expect(asksToRun(swarm, true, false)).toBe(false)
    expect(asksToRun(swarm, false, true)).toBe(false)
    expect(asksToRun({ ...swarm, orients: false }, true, true)).toBe(false)
  })
  it('asks while the server offers it, and never for a locked row', () => {
    expect(asksToRun({ ...swarm, on: true, offer: true }, true, true)).toBe(true)
    expect(asksToRun({ ...swarm, on: true, offer: false }, true, true)).toBe(false)
    expect(asksToRun({ ...swarm, locked: true }, true, true)).toBe(false)
  })
  it('sends only the answers of rows that still ask', () => {
    const data = { extensions: [swarm, { ...swarm, name: 'other' }], conflicts: [], orientation_ran: true }
    expect(answeredRuns(data, { swarm: true, other: false }, { swarm: true, other: true })).toEqual([['swarm', true]])
  })
})

describe('tasksLine', () => {
  const task = (t: string, way: 'thimble' | 'prompt' | 'sdk' | 'command', extension = '', additions: string[] = [], conflict: string[] = []) => ({ task: t, way, extension, additions, conflict })

  it('names only the tasks an extension changes, each with who runs it', async () => {
    const { tasksLine } = await import('../../src/shell/SettingsPopover')
    expect(tasksLine([task('labels', 'thimble'), task('card-check', 'thimble')])).toBe('')
    const line = tasksLine([task('labels', 'command', 'vote-labels'), task('view-fit', 'thimble'), task('checks', 'thimble', '', [], ['a', 'b'])])
    expect(line).toContain('labels')
    expect(line).toContain('vote-labels')
    expect(line).toContain('checks')
    expect(line).not.toContain('view-fit')
    const one = tasksLine([task('label-draft', 'command', 'pass'), task('card-check', 'command', 'pass'), task('checks', 'command', 'pass')])
    expect(one.match(/pass/g)).toHaveLength(1)
    expect(one).toContain('label-draft')
    expect(one).toContain('checks')
  })
})

describe('the labels and card check rows', () => {
  const agent = (over: Record<string, unknown> = {}) => ({ way: 'thimble', extension: '', additions: [], conflict: [], sandbox: 'on', sandbox_runs: true, network: 'on', web: 'off', data: 'ask', config: 'agents.labels', ...over }) as import('../../src/lib/types').AgentRow

  it('say what a program of their tasks may do, and that with no thread to ask in it never edits the data at ask', async () => {
    const { agentLine, agentTip, CALL_ROWS } = await import('../../src/shell/SettingsPopover')
    expect(CALL_ROWS.map((r) => r.agent)).toEqual(['labels', 'cardCheck'])
    const labels = agent({ tasks: ['labels', 'label-draft', 'view-fit'] })
    expect(agentLine(labels)).toContain('never edits data')
    expect(agentLine(agent())).toContain('asks to edit data')
    expect(agentLine(agent({ tasks: ['card-check'], data: 'allow' }))).toContain('may edit data')
    expect(agentTip(labels)).toContain('labels, label-draft or view-fit')
    expect(agentTip(labels)).toContain('agents.labels')
  })
})
