// @vitest-environment jsdom
// Color by in Files' Transcript and Table modes (src/files/useColorBy.ts, colorContext.ts): each choice colors every
// record by its value of that choice, a band per choice in the tracks' order, a key's value in its colors and a label's
// highlighted value in the label's; a record with no value of a choice has no band there.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { colourVar } from '../../src/files/labels'
import { keyColor, writeColor, type ColorChoice } from '../../src/files/colorChoice'
import { useColorBy, type ColorBy } from '../../src/files/useColorBy'
import type { FilesLabels } from '../../src/files/useLabels'
import type { Concept, LabelRow, SourceKeys, SourceRecord } from '../../src/lib/types'
import { mount, settle, unmountAll } from './mount.tsx'

const PATH = 'chat.jsonl'
const KEYS: SourceKeys = {
  path: PATH,
  total: 5,
  bins: 0,
  partial: false,
  bytes: [],
  keys: [
    { key: 'type', values: [{ value: 'assistant', n: 2 }, { value: 'user', n: 2 }], more: { values: 0, n: 0 }, none: 1, at: [] },
    { key: 'tool', values: [{ value: 'Bash', n: 1 }], more: { values: 0, n: 0 }, none: 4, at: [] },
  ],
}
const TACTIC = {
  id: 'a',
  name: 'tactic',
  description: '',
  unit: 'record',
  kind: 'regex',
  spec: '',
  labels: ['tactic', 'other'],
  created_by: 'analyst',
  ts: '',
  classes: [
    { name: 'tactic', color: 15, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
} as unknown as Concept
// line 5 says no type: the first choice gives it no value
const TYPES = ['user', 'assistant', 'user', 'assistant', null]
const RECORDS: SourceRecord[] = TYPES.map((type, i) => ({ line: i + 1, record: type ? { type, text: `turn ${i + 1}` } : { text: 'a note' }, blocks: [], meta: {} }) as unknown as SourceRecord)
// "tactic" marks lines 2 and 5; line 4 is "other", which the label does not highlight; lines 1 and 3 it never read
const row = (line: number, label: string): LabelRow => ({ ref: `${PATH}#L${line}`, label, confidence: null, source: 'regex' })
const ROWS = new Map<string, Map<string, LabelRow>>([
  [`${PATH}#L2`, new Map([['a', row(2, 'tactic')]])],
  [`${PATH}#L4`, new Map([['a', row(4, 'other')]])],
  [`${PATH}#L5`, new Map([['a', row(5, 'tactic')]])],
])
const labels: FilesLabels = {
  all: [TACTIC],
  on: [TACTIC],
  focus: null,
  setFocus: () => undefined,
  byId: new Map([['a', TACTIC]]),
  presence: new Map([['a', { [PATH]: { tactic: 2, other: 1 } }]]),
  toggle: () => undefined,
  setClasses: () => undefined,
  setColour: () => undefined,
  save: async () => TACTIC,
  remove: async () => undefined,
} as unknown as FilesLabels

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(KEYS), { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  localStorage.clear()
})

let got: ColorBy | null = null
function Harness() {
  got = useColorBy('w', PATH, true, labels, RECORDS, ROWS, 5)
  return null
}
const bands = (line: number) => got!.colors?.get(line)?.bands ?? null

const USER = keyColor(1)
const ASSISTANT = keyColor(0)
const PURPLE = colourVar(15)

test('Color by a key and a label colors each record by its value of each, and none where it has no value', async () => {
  writeColor('w', PATH, { by: 'k:type', picks: ['k:type', 'l:a'], off: {} })
  await mount(<Harness />)
  await settle()
  expect(got!.picks.map((c: ColorChoice) => (c.by === 'key' ? c.key : c.by === 'label' ? c.id : 'off'))).toEqual(['type', 'a'])
  expect(bands(1)).toEqual([USER, null])
  expect(bands(2)).toEqual([ASSISTANT, PURPLE])
  expect(bands(3)).toEqual([USER, null])
  // "other" is no value the label colors by: no band, as its lane leaves it out
  expect(bands(4)).toEqual([ASSISTANT, null])
  // no type, but "tactic": an empty first band and the label's
  expect(bands(5)).toEqual([null, PURPLE])
  expect(got!.colors!.get(5)!.color).toBeNull()
})
