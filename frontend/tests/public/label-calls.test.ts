// A view's own label calls as thimble does them (src/files/labelCalls.ts runLabelCall), once the analyst's gesture let
// them through: a mark is stored as the analyst's value on the record, or on the file for a label of whole files, the
// filter is set and cleared, and a call thimble cannot do comes back with its reason and stores nothing.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runLabelCall } from '../../src/files/labelCalls.ts'
import type { Concept } from '../../src/lib/types.ts'

type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []

beforeEach(() => {
  calls = []
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:8300' })
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => vi.unstubAllGlobals())

const label = (id: string, unit: string) =>
  ({ id, name: id, unit, kind: 'regex', labels: ['yes', 'no'], classes: [{ name: 'yes', color: 2, highlight: true }, { name: 'no', color: 0, highlight: false }] }) as unknown as Concept
const byId = new Map([
  ['asks', label('asks', 'record')],
  ['noisy', label('noisy', 'agent')],
  ['runs', label('runs', 'run')],
])
const ctx = { ws: 'w', byId, palette: [] }

describe("a view's label calls", () => {
  test("a mark is the analyst's value on the record, or on its file for a label of whole files", async () => {
    await runLabelCall('mark', { ref: 'board.jsonl#L3', label: 'asks', value: 'yes' }, ctx)
    await runLabelCall('mark', { ref: 'board.jsonl#L3', label: 'noisy', value: 'no' }, ctx)
    await runLabelCall('mark', { ref: 'events.jsonl', label: 'noisy', value: 'yes' }, ctx)
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/ws/w/concepts/asks/labels', { ref: 'board.jsonl#L3', label: 'yes' }],
      ['POST', '/api/ws/w/concepts/noisy/labels', { ref: 'board.jsonl', label: 'no' }],
      ['POST', '/api/ws/w/concepts/noisy/labels', { ref: 'events.jsonl', label: 'yes' }],
    ])
  })

  test('the filter is set by a value and cleared with null', async () => {
    await runLabelCall('filter', { label: 'asks', value: 'yes' }, ctx)
    await runLabelCall('filter', { label: null, value: null }, ctx)
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['PUT', '/api/ws/w/filters', { scope: 'files', concept: 'asks', value: 'yes' }],
      ['DELETE', '/api/ws/w/filters/files', null],
    ])
  })

  test('a call thimble cannot do says why and stores nothing', async () => {
    await expect(runLabelCall('mark', { ref: 'board.jsonl#L3', label: 'asks', value: 'maybe' }, ctx)).rejects.toThrow('asks has no value "maybe"')
    await expect(runLabelCall('mark', { ref: 'board', label: 'asks', value: 'yes' }, ctx)).rejects.toThrow("mark takes a record's ref")
    await expect(runLabelCall('mark', { ref: 'run-1/a.jsonl#L1', label: 'runs', value: 'yes' }, ctx)).rejects.toThrow('runs labels whole runs, not records')
    await expect(runLabelCall('on', { id: 'asks', on: true }, ctx)).rejects.toThrow('labels cannot be turned on or off here')
    await expect(runLabelCall('filter', { label: 'nope', value: 'yes' }, ctx)).rejects.toThrow('no label has the id or name "nope"')
    expect(calls).toEqual([])
  })
})
