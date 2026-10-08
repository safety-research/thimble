// @vitest-environment jsdom
// Color by's state in Files (src/files/useColorBy.ts), as a view's Color by keeps it: several choices in order, the
// first the color and each other a lane of the tracks. A file kept with one choice before opens on it. Checking a label
// that is off turns it on in Files, and it keeps the place it was checked in once it is on; unchecking one turns it off,
// unless Filter by filters by it. A label turned on anywhere else takes the first place: a key that was the color gives
// way and comes back when the labels go off. Off is no choice at all, kept for the file; unchecking the last is Off.
import { act, useRef, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readColor, writeColor, type ColorChoice } from '../../src/files/colorChoice'
import { useColorBy, type ColorBy } from '../../src/files/useColorBy'
import type { FilesLabels } from '../../src/files/useLabels'
import type { Concept, SourceKeys } from '../../src/lib/types'
import { mount, settle, unmountAll } from './mount.tsx'

const PATH = 'run.jsonl'
const KEYS: SourceKeys = {
  path: PATH,
  total: 10,
  bins: 0,
  partial: false,
  bytes: [],
  keys: [{ key: 'wiki', values: [{ value: 'dse', n: 9 }], more: { values: 0, n: 0 }, none: 1, at: [] }],
}
const concept = (id: string, name: string): Concept =>
  ({
    id,
    name,
    description: '',
    unit: 'record',
    kind: 'prompt',
    spec: '',
    labels: ['yes', 'no'],
    created_by: 'analyst',
    ts: '',
    classes: [
      { name: 'yes', color: 1, highlight: true },
      { name: 'no', color: 0, highlight: false },
    ],
  }) as unknown as Concept
const A = concept('a', 'passed on')
const B = concept('b', 'links')

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(KEYS), { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  localStorage.clear()
})

let got: ColorBy | null = null
const toggle = vi.fn()
const setFocus = vi.fn()
const labelsOf = (on: string[]): FilesLabels =>
  ({
    all: [A, B],
    on: [A, B].filter((k) => on.includes(k.id)),
    focus: null,
    setFocus,
    byId: new Map([A, B].map((k) => [k.id, k])),
    presence: new Map([A, B].map((k) => [k.id, { [PATH]: { yes: 3 } }])),
    toggle,
    setClasses: () => undefined,
    setColour: () => undefined,
    save: async () => A,
    remove: async () => undefined,
  }) as unknown as FilesLabels

function Harness({ on, holds = null }: { on: string[]; holds?: string | null }) {
  const held = useRef<string | null>(null)
  held.current = holds
  const quiet = useRef(new Set<string>())
  got = useColorBy('w', PATH, true, labelsOf(on), [], new Map(), 10, quiet, held)
  return null
}

const ids = (picks: readonly ColorChoice[]) => picks.map((c) => (c.by === 'key' ? `k:${c.key}` : c.by === 'label' ? `l:${c.id}` : 'off'))

let set: ((v: { on: string[]; holds: string | null }) => void) | null = null
function Root({ on }: { on: string[] }) {
  const [s, setS] = useState({ on, holds: null as string | null })
  set = setS
  return <Harness on={s.on} holds={s.holds} />
}

/** The harness mounted with the labels `on`, once the file's keys came. */
async function start(on: string[]) {
  await mount(<Root on={on} />)
  await settle()
}

/** The harness drawn again with the labels `on`, as Files gives them when one is turned on or off, and the label Filter
 * by filters by. */
async function draw(on: string[], holds: string | null = null) {
  act(() => set!({ on, holds }))
  await settle()
}

beforeEach(() => {
  toggle.mockClear()
  setFocus.mockClear()
})

test('a file kept with one choice opens on it, and the choices and the key chosen last are kept for it', async () => {
  writeColor('w', PATH, { by: 'k:wiki', off: {} })
  await start([])
  expect(ids(got!.picks)).toEqual(['k:wiki'])
  expect(got!.choice).toEqual({ by: 'key', key: 'wiki' })
  await act(async () => got!.choose({ by: 'off' }))
  expect(ids(got!.picks)).toEqual([])
  expect(got!.choice).toEqual({ by: 'off' })
  expect(got!.colors).toBeNull()
  expect(readColor('w', PATH)).toMatchObject({ by: 'off', picks: [] })
})

test("a label checked while off is turned on and keeps its place after the key: a track, not the color", async () => {
  await start([])
  expect(ids(got!.picks)).toEqual(['k:wiki'])
  await act(async () => got!.choose({ by: 'label', id: 'a' }))
  expect(toggle).toHaveBeenCalledWith('a')
  expect(setFocus).toHaveBeenCalledWith('a')
  expect(readColor('w', PATH).picks).toEqual(['k:wiki', 'l:a'])
  // Files says it is on
  await draw(['a'])
  expect(ids(got!.picks)).toEqual(['k:wiki', 'l:a'])
  expect(got!.choice).toEqual({ by: 'key', key: 'wiki' })
})

test('a label unchecked is turned off, unless Filter by filters by it; the last unchecked is Off', async () => {
  writeColor('w', PATH, { by: 'l:a', picks: ['l:a', 'l:b'], off: {} })
  await start(['a', 'b'])
  expect(ids(got!.picks)).toEqual(['l:a', 'l:b'])
  await act(async () => got!.choose({ by: 'label', id: 'b' }))
  expect(toggle).toHaveBeenCalledWith('b')
  expect(ids(got!.picks)).toEqual(['l:a'])
  toggle.mockClear()
  // Filter by holds "passed on": unchecked, it leaves Color by and stays on
  await draw(['a'], 'a')
  await act(async () => got!.choose({ by: 'label', id: 'a' }))
  expect(toggle).not.toHaveBeenCalled()
  expect(ids(got!.picks)).toEqual([])
  expect(readColor('w', PATH).by).toBe('off')
})

test('a label turned on elsewhere takes the first place; the key that was the color gives way and comes back when the labels go off', async () => {
  writeColor('w', PATH, { by: 'k:wiki', off: {} })
  await start([])
  await draw(['a'])
  expect(ids(got!.picks)).toEqual(['l:a'])
  // a second one: it takes the color, the first keeps its lane
  await draw(['a', 'b'])
  expect(ids(got!.picks)).toEqual(['l:b', 'l:a'])
  expect(toggle).not.toHaveBeenCalled()
  // both turned off: the key chosen last
  await draw([])
  expect(ids(got!.picks)).toEqual(['k:wiki'])
})
