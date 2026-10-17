// A trial, a label run on a sample of its records (backend concepts.py, Trials), is listed in the Labels pane with the
// other labels, its row's count marked as a sample, as the canvas and the terminal say it (`a sample of 30`).
import { expect, test } from 'vitest'
import { labelStatus, outcomeText } from '../../src/files/labels.ts'
import type { Concept } from '../../src/lib/types.ts'

const label = (trial: boolean): Concept =>
  ({
    id: 'k1',
    name: 'test or probe',
    unit: 'record',
    kind: 'prompt',
    labels: ['yes', 'no'],
    counts: { yes: 20, no: 10 },
    trial,
    last_run: { ts: '2026-10-08T10:00:00+00:00', paths: ['posts.jsonl'], total: 30, labeled: 30, failed: 0, status: 'done', matches: 20, limit: 30 },
  }) as unknown as Concept

test("a trial's count in the Labels pane says it ran on a sample; a label run on everything's does not", () => {
  const trial = labelStatus(label(true))
  expect(trial?.state === 'done' && outcomeText(trial)).toBe('20 of a sample of 30 records')
  const all = labelStatus(label(false))
  expect(all?.state === 'done' && outcomeText(all)).toBe('20 of 30 records')
})
