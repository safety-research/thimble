// @vitest-environment jsdom
// The Labels pane follows a running label by reading it once a second (useLabelRuns in src/files/ViewSide.tsx) until its
// run ends. A label deleted while it runs, or one the server answers 404 for, is followed no more (bug hunt G13: after a
// running label was deleted, the page read it once a second until a reload, 315 times in 6 minutes, each a 404).
import { act, useEffect } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { useLabelRuns, type LabelRuns } from '../../src/files/ViewSide.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { Concept } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

const running = {
  id: 'tide1',
  name: 'mentions the tide',
  unit: 'record',
  kind: 'prompt',
  glob: 'logbook.jsonl',
  labels: ['match', 'no match'],
  classes: [],
  run: { status: 'running', run_id: 'r1', done: 40, total: 900 },
} as unknown as Concept

const labels: FilesLabels = {
  all: [running],
  on: [],
  focus: null,
  setFocus: () => undefined,
  byId: new Map([[running.id, running]]),
  presence: new Map(),
  toggle: () => undefined,
  setClasses: () => undefined,
  setColour: () => undefined,
  save: async () => running,
  remove: async () => undefined,
}

/** the reads of the label, and what the server answers them: the label running, or 404 once it is gone */
let reads = 0
let gone = false
let seen: LabelRuns | null = null

beforeEach(() => {
  reads = 0
  gone = false
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(String(url), 'http://thimble.test').pathname
    const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
    if (path.endsWith('/concepts/tide1')) {
      reads += 1
      return gone ? answer(404, { detail: 'no such concept: tide1' }) : answer(200, running)
    }
    return answer(404, {})
  })
})
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Probe() {
  const runs = useLabelRuns('w', labels)
  useEffect(() => {
    seen = runs
  })
  return null
}

/** Let `n` seconds of polling pass, each read answered. */
const seconds = (n: number) => act(async () => void (await vi.advanceTimersByTimeAsync(n * 1000)))

test('a running label the server answers 404 for is read no more', async () => {
  await mount(<Probe />)
  await seconds(3)
  expect(reads).toBe(3)
  gone = true
  await seconds(1)
  expect(reads).toBe(4)
  await seconds(10)
  expect(reads).toBe(4)
  expect(seen!.runs.has('tide1')).toBe(false)
})

test('a running label deleted is read no more, with no read to find it gone', async () => {
  await mount(<Probe />)
  await seconds(2)
  expect(reads).toBe(2)
  act(() => bus.emit('concepts', { concept: 'tide1', what: 'deleted' }))
  await seconds(10)
  expect(reads).toBe(2)
})
