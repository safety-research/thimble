// @vitest-environment jsdom
// A label's details (src/canvas/LabelDetails.tsx APPLIED TO) count the corpus files its rows cover from the coverage
// route's counts, list the files with no rows a page at a time, each page read from where the list ends, and start
// over from the first page when the label changes.
import { act, useState } from 'react'
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

function answer(offset: number): ConceptCoverage {
  return {
    unit: 'record',
    n_files: 452,
    n_covered: 2,
    rows: 9,
    files: [
      { path: 'a.jsonl', covered: true, rows: 4 },
      { path: 'b.jsonl', covered: true, rows: 5 },
    ],
    not_covered: MISSING.slice(offset, offset + 200),
    n_not_covered: MISSING.length,
    offset,
  }
}

const concept = (n_labeled: number) => ({ id: 'k1', name: 'mentions dse', unit: 'record', kind: 'regex', spec: 'dse', labels: ['yes', 'no'], counts: {}, n_labeled, version: 1 }) as unknown as ConceptDetail

let setConcept: (k: ConceptDetail) => void = () => undefined

function View({ first }: { first: ConceptDetail }) {
  const [k, set] = useState(first)
  setConcept = set
  return (
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }}>
      <LabelDetails concept={k} reload={async () => undefined} set={() => undefined} />
    </CanvasContext.Provider>
  )
}

const read = (el: HTMLElement) => {
  const sec = [...el.querySelectorAll('.canvas-details-section')].find((s) => s.querySelector('.label')?.textContent === 'applied to')!
  return {
    chips: [...sec.querySelectorAll('.canvas-details-run .chip')].map((c) => c.textContent),
    listed: [...sec.querySelectorAll('.canvas-label-file')].map((li) => li.textContent),
    actions: [...sec.querySelectorAll('.canvas-details-actions button, .canvas-details-actions .chip')].map((b) => b.textContent),
    more: [...sec.querySelectorAll<HTMLButtonElement>('.canvas-details-actions button')][0],
  }
}

test('the files with no rows show a page at a time, each read from where the list ends, and a new label run starts over', async () => {
  const asked: number[] = []
  vi.spyOn(labelApi, 'coverage').mockImplementation(async (_c, _id, offset = 0) => {
    asked.push(offset)
    return answer(offset)
  })
  vi.spyOn(labelApi, 'rows').mockResolvedValue({ rows: [], total: 0 })
  const el = await mount(<View first={concept(9)} />)
  await settle()
  let got = read(el)
  expect(got.chips).toContain('2 of 452 files')
  expect(got.listed).toEqual(MISSING.slice(0, 200))
  expect(got.actions).toEqual(['200 more', '200 of 450'])

  await act(async () => got.more.click())
  await settle()
  got = read(el)
  expect(got.listed).toEqual(MISSING.slice(0, 400))
  expect(got.actions).toEqual(['50 more', '400 of 450'])

  await act(async () => got.more.click())
  await settle()
  got = read(el)
  expect(got.listed).toEqual(MISSING)
  expect(got.actions).toEqual([])
  expect(asked).toEqual([0, 200, 400])

  await act(async () => setConcept(concept(10)))
  await settle()
  got = read(el)
  expect(got.listed).toEqual(MISSING.slice(0, 200))
  expect(got.actions).toEqual(['200 more', '200 of 450'])
  expect(asked).toEqual([0, 200, 400, 0])
})
