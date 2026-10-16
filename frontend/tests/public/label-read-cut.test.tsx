// @vitest-environment jsdom
// The whole files a prompt label read only in part (the run's `cut`, backend concepts.read_cut): the Labels pane and
// the label's card on the canvas show one dim line under the label's counts, in tokens, which opens to list the files;
// the line comes from the label's last run, or from a run that ended after it, and goes once a run of the label cuts
// none.
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { labelStatus } from '../../src/files/labels.ts'
import type { Concept, ConceptRun, ReadCut } from '../../src/lib/types.ts'
import { unmountAll } from './mount.tsx'

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

describe("a label's read cut", () => {
  test('is the last run’s, or a later run’s, and none once a run cuts none', () => {
    expect(labelStatus(label(CUT))).toMatchObject({ state: 'done', cut: CUT })
    expect(labelStatus(label(null))).toMatchObject({ state: 'done', cut: null })
    const later: ConceptRun = { status: 'done', started: '2026-10-08T11:00:00+00:00', total: 5, matches: 2, failed: 0, cut: null }
    expect(labelStatus(label(CUT), later)).toMatchObject({ state: 'done', cut: null })
    expect(labelStatus(label(null), { ...later, cut: CUT })).toMatchObject({ state: 'done', cut: CUT })
  })
})
