// @vitest-environment jsdom
// The whole files a prompt label read only in part (the run's `cut`, backend concepts.read_cut): the Labels pane and
// the label's card on the canvas show one dim line under the label's counts, in tokens, which opens to list the files;
// the line comes from the label's last run, or from a run that ended after it, and goes once a run of the label cuts
// none.
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { CardBody } from '../../src/canvas/bodies.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { LabelsPane } from '../../src/files/LabelsPane.tsx'
import { labelStatus } from '../../src/files/labels.ts'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { api, labelApi } from '../../src/lib/api.ts'
import type { Cell, Concept, ConceptDetail, ConceptRun, ReadCut } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const CUT: ReadCut = {
  n: 3,
  of: 5,
  short: 0,
  tokens: 905_000,
  refs: ['agents/a1.jsonl', 'agents/a2.jsonl'],
  line: '3 of 5 files were longer than the model reads; it read the first ~905k tokens of each',
}

const run = (cut?: ReadCut | null) => ({ ts: '2026-10-08T10:00:00+00:00', paths: ['agents/*.jsonl'], total: 5, labeled: 5, failed: 0, status: 'done', matches: 2, ...(cut ? { cut } : {}) })

const label = (cut?: ReadCut | null): Concept =>
  ({
    id: 'k1',
    name: 'ran a command',
    description: 'The agent ran a shell command.',
    unit: 'agent',
    kind: 'prompt',
    spec: '',
    glob: 'agents/*.jsonl',
    marks: 'file',
    labels: ['yes', 'no'],
    counts: { yes: 2, no: 3 },
    created_by: 'chat',
    ts: '',
    shown: false,
    classes: [
      { name: 'yes', color: 1, highlight: true },
      { name: 'no', color: 0, highlight: false },
    ],
    last_run: run(cut),
  }) as unknown as Concept

function labelsOf(k: Concept): FilesLabels {
  return {
    all: [k],
    on: [],
    focus: null,
    setFocus: () => undefined,
    byId: new Map([[k.id, k]]),
    presence: new Map(),
    toggle: () => undefined,
    setClasses: () => undefined,
    setColour: () => undefined,
    save: async () => k,
    remove: async () => undefined,
  }
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const pane = (k: Concept, runs: ReadonlyMap<string, ConceptRun> = new Map()) => mount(<LabelsPane labels={labelsOf(k)} open onToggleOpen={() => undefined} editing={null} onEdit={() => undefined} runs={runs} onRetry={async () => undefined} />)

describe("a label's read cut", () => {
  test('is the last run’s, or a later run’s, and none once a run cuts none', () => {
    expect(labelStatus(label(CUT))).toMatchObject({ state: 'done', cut: CUT })
    expect(labelStatus(label(null))).toMatchObject({ state: 'done', cut: null })
    const later: ConceptRun = { status: 'done', started: '2026-10-08T11:00:00+00:00', total: 5, matches: 2, failed: 0, cut: null }
    expect(labelStatus(label(CUT), later)).toMatchObject({ state: 'done', cut: null })
    expect(labelStatus(label(null), { ...later, cut: CUT })).toMatchObject({ state: 'done', cut: CUT })
  })

  test('shows one dim line under the counts, which opens to list the files', async () => {
    const el = await pane(label(CUT))
    const line = el.querySelector<HTMLButtonElement>('.files-label-status .read-cut-line')
    expect(line?.textContent).toBe(CUT.line)
    expect(line?.textContent).toContain('tokens')
    expect(line?.getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector('.read-cut-refs')).toBeNull()
    await act(async () => line!.click())
    const items = [...el.querySelectorAll('.read-cut-refs li')].map((li) => li.textContent)
    expect(items).toEqual(['agents/a1.jsonl', 'agents/a2.jsonl', 'and 1 more'])
    await act(async () => line!.click())
    expect(el.querySelector('.read-cut-refs')).toBeNull()
  })

  test('is not shown for a run that read every file whole', async () => {
    const el = await pane(label(null))
    expect(el.querySelector('.files-label-status')).not.toBeNull()
    expect(el.querySelector('.read-cut')).toBeNull()
  })
})

test("the label's card shows the line under its counts, from the last run its detail keeps", async () => {
  vi.spyOn(labelApi, 'rows').mockResolvedValue({ rows: [], total: 0 })
  vi.spyOn(api, 'settings').mockRejectedValue(new Error('no server'))
  const { last_run: _kept, ...rest } = label(CUT) as Concept & { last_run: unknown }
  const detail = { ...rest, applications: [run(null), run(CUT)] } as unknown as ConceptDetail
  const cell = { id: 'c1', kind: 'label', title: 'ran a command', payload: { concept: 'k1' } } as unknown as Cell
  const card = (k: ConceptDetail) =>
    mount(
      <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }}>
        <CardBody cell={cell} width={400} label={{ concept: k, error: null, reload: async () => undefined, set: () => undefined } as never} />
      </CanvasContext.Provider>,
    )
  let el = await card(detail)
  await settle()
  expect(el.querySelector('.bcell-label .bcell-label-cut .read-cut-line')?.textContent).toBe(CUT.line)
  unmountAll()
  el = await card({ ...detail, applications: [run(CUT), run(null)] } as ConceptDetail)
  await settle()
  expect(el.querySelector('.bcell-label')).not.toBeNull()
  expect(el.querySelector('.read-cut')).toBeNull()
})
