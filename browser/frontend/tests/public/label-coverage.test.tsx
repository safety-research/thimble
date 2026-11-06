// @vitest-environment jsdom
// A label's coverage in its details (src/canvas/LabelDetails.tsx APPLIED TO): how many of the corpus's files its rows
// cover, from the coverage route's counts, and the files with no rows, a page at a time.
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { LabelDetails } from '../../src/canvas/LabelDetails.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { labelApi } from '../../src/lib/api.ts'
import type { ConceptCoverage, ConceptDetail } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

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

const MISSING = Array.from({ length: 450 }, (_, i) => `logs/day-${String(i).padStart(3, '0')}.jsonl`)
const COVERAGE: ConceptCoverage = {
  unit: 'record',
  n_files: 452,
  n_covered: 2,
  rows: 9,
  files: [
    { path: 'a.jsonl', covered: true, rows: 4 },
    { path: 'b.jsonl', covered: true, rows: 5 },
  ],
  not_covered: MISSING.slice(0, 200),
  n_not_covered: MISSING.length,
  offset: 0,
}
const LABEL = { id: 'k1', name: 'mentions dse', unit: 'record', kind: 'regex', spec: 'dse', labels: ['yes', 'no'], counts: {}, n_labeled: 9, version: 1 } as unknown as ConceptDetail
const ctx = { ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }

test("a label's details count the files its rows cover, and list the files it found none in", async () => {
  vi.spyOn(labelApi, 'coverage').mockResolvedValue(COVERAGE)
  vi.spyOn(labelApi, 'rows').mockResolvedValue({ rows: [], total: 0 })
  const el = await mount(
    <CanvasContext.Provider value={ctx}>
      <LabelDetails concept={LABEL} reload={async () => undefined} set={() => undefined} />
    </CanvasContext.Provider>,
  )
  await settle()
  const section = [...el.querySelectorAll('.canvas-details-section')].find((s) => s.querySelector('.label')?.textContent === 'applied to')!
  expect([...section.querySelectorAll('.canvas-details-run .chip')].map((c) => c.textContent)).toContain('2 of 452 files')
  expect([...section.querySelectorAll('.canvas-label-file')].map((li) => li.textContent)).toEqual(MISSING.slice(0, 200))
  expect([...section.querySelectorAll('.canvas-details-actions button, .canvas-details-actions .chip')].map((b) => b.textContent)).toEqual(['200 more', '200 of 450'])
})
