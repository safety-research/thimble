// How the labels of many records reach the page (src/files/marks.tsx): the blocks and refs asked for in one turn go out
// in a few requests, never more than ASKS_IN_FLIGHT at once, what records in view want before the rest, a failed request
// is asked again, and an event that changed no rows reads nothing again.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LabelsForPath } from '../../src/lib/types.ts'

type Marks = typeof import('../../src/files/marks.tsx')
type Calls = { spans: [string, [number, number][]][]; refs: string[][]; open: number; most: number; fail: number }

let marks: Marks
let bus: typeof import('../../src/lib/bus.ts').bus
let calls: Calls
let pending: (() => void)[]

const row = (ref: string) => ({ concept_id: 'k1', name: 'k', labels: ['yes', 'no'], unit: 'record', rows: [{ ref, label: 'yes', confidence: 1, source: 'regex' }] }) as LabelsForPath

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  calls = { spans: [], refs: [], open: 0, most: 0, fail: 0 }
  pending = []
  const { scaleApi } = await import('../../src/lib/api.ts')
  const answer = <T,>(make: () => T) =>
    new Promise<T>((resolve, reject) => {
      calls.open += 1
      calls.most = Math.max(calls.most, calls.open)
      pending.push(() => {
        calls.open -= 1
        if (calls.fail > 0) {
          calls.fail -= 1
          reject(new Error('503'))
        } else resolve(make())
      })
    })
  vi.spyOn(scaleApi, 'labelsForSpans').mockImplementation((_c, path, lines) => {
    const spans = lines.split(',').map((s) => s.split('-').map(Number) as [number, number])
    calls.spans.push([path, spans])
    return answer(() => spans.map(([a]) => row(`${path}#L${a}`)))
  })
  vi.spyOn(scaleApi, 'labelsForRefs').mockImplementation((_c, refs) => {
    calls.refs.push([...refs])
    return answer(() => refs.map(row))
  })
  marks = await import('../../src/files/marks.tsx')
  bus = (await import('../../src/lib/bus.ts')).bus
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Answer the requests out one at a time, letting the next go out, until none is left. */
async function drain(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await vi.advanceTimersByTimeAsync(0)
    const next = pending.shift()
    if (!next) return
    next()
    await Promise.resolve()
  }
}

describe('label requests', () => {
  test('a view with records on 1,510 pages of a file asks for them in a few requests, four at most at once', async () => {
    const off = marks.watchPathLabels('w', 'events.jsonl', () => {})
    for (let b = 0; b < 1510; b++) marks.wantLabels('w', 'events.jsonl', b * marks.LABEL_BLOCK + 7)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.open).toBe(marks.ASKS_IN_FLIGHT)
    await drain()
    expect(calls.most).toBe(marks.ASKS_IN_FLIGHT)
    expect(calls.spans.length).toBe(Math.ceil(1510 / marks.BLOCKS_PER_ASK))
    // the blocks next to each other go as one range
    expect(calls.spans[0][1]).toEqual([[1, marks.BLOCKS_PER_ASK * marks.LABEL_BLOCK]])
    expect(marks.labelsArrived('w', 'events.jsonl', `events.jsonl#L${1509 * marks.LABEL_BLOCK + 7}`)).toBe(true)
    off()
  })

  test('what records in view want goes first, even when it was asked for before', async () => {
    for (let b = 0; b < 200; b++) marks.wantLabels('w', 'a.jsonl', b * marks.LABEL_BLOCK + 1)
    marks.wantLabels('w', 'a.jsonl', 150 * marks.LABEL_BLOCK + 1, true)
    for (let i = 0; i < 3000; i++) marks.wantRecordLabels('w', 'b.jsonl', `b.jsonl#L${i + 1}`)
    marks.wantRecordLabels('w', 'b.jsonl', 'b.jsonl#L2999', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.spans[0]).toEqual(['a.jsonl', [[150 * marks.LABEL_BLOCK + 1, 151 * marks.LABEL_BLOCK]]])
    expect(calls.refs[0]).toEqual(['b.jsonl#L2999'])
    await drain()
    expect(calls.refs.flat().length).toBe(3000)
    expect(calls.refs.every((r) => r.length <= 1000)).toBe(true)
  })

  test('a failed request is asked again', async () => {
    calls.fail = 1
    marks.wantRecordLabels('w', 'c.jsonl', 'c.jsonl#L4')
    await drain()
    expect(marks.labelsArrived('w', 'c.jsonl', 'c.jsonl#L4')).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    await drain()
    expect(calls.refs).toEqual([['c.jsonl#L4'], ['c.jsonl#L4']])
    expect(marks.labelsArrived('w', 'c.jsonl', 'c.jsonl#L4')).toBe(true)
  })

  test('a label turned on reads nothing again; a run that changed rows reads what had arrived, and shows new records at once', async () => {
    const seen: number[] = []
    const off = marks.watchPathLabels('w', 'd.jsonl', (rows) => seen.push(rows.size))
    marks.wantRecordLabels('w', 'd.jsonl', 'd.jsonl#L1')
    await drain()
    expect(seen.at(-1)).toBe(1)
    bus.emit('concepts', { concept: 'k1', what: 'changed', rows: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.refs.length).toBe(1)
    bus.emit('concepts', { concept: 'k1', what: 'applied', rows: true })
    marks.wantRecordLabels('w', 'd.jsonl', 'd.jsonl#L2')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.refs.slice(1).flat().sort()).toEqual(['d.jsonl#L1', 'd.jsonl#L2'])
    await drain()
    expect(seen.at(-1)).toBe(2)
    off()
  })
})
