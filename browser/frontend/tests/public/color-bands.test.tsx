// @vitest-environment jsdom
// A record's left edge under Color by in Files' Transcript and Table modes (src/files/useColorBy.ts, colorContext.ts,
// views/common.tsx EdgeBands): a band per choice, in the tracks' order, each in the color of the record's value of that
// choice, as its lane of the tracks colors it: a key's value in its colors, a label's highlighted value in the label's.
// A record with no value of a choice has no band there. A value turned off takes its color off its records, which stay
// drawn. With a label first, a record of a highlighted value takes the value's color as a tint across its row. How the
// bands look in a browser is tests/public/browser/color-bands.test.ts.
import { act} from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { colourVar } from '../../src/files/labels'
import { keyColor, writeColor, type ColorChoice } from '../../src/files/colorChoice'
import { ColorContext} from '../../src/files/colorContext'
import { useColorBy, type ColorBy } from '../../src/files/useColorBy'
import type { FilesLabels } from '../../src/files/useLabels'
import { RecordCard } from '../../src/files/views/common'
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

test('two choices give each record two bands, the first in its key value\'s color and the second in its label value\'s, none where it has no value', async () => {
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
  // the same colors are one array
  expect(bands(1)).toBe(bands(3))
})

test("a value turned off only takes its color off its records: they stay, with no band of the first choice and the other choices' bands kept; on again, the color is back", async () => {
  writeColor('w', PATH, { by: 'k:type', picks: ['k:type', 'l:a'], off: {} })
  function Records() {
    got = useColorBy('w', PATH, true, labels, RECORDS, ROWS, 5)
    return (
      <ColorContext.Provider value={got.colors}>
        {RECORDS.map((r) => (
          <RecordCard key={r.line} path={PATH} line={r.line} target={null} hit={false} header="turn">
            words
          </RecordCard>
        ))}
      </ColorContext.Provider>
    )
  }
  const el = await mount(<Records />)
  await settle()
  await act(async () => got!.toggle('user', false))
  expect(got!.off).toEqual(['user'])
  // lines 1 and 3 say "user": no color and an empty first band; the label leaves them none either
  expect(got!.colors!.get(1)!.color).toBeNull()
  expect(bands(1)).toEqual([null, null])
  expect(bands(3)).toEqual([null, null])
  expect(bands(2)).toEqual([ASSISTANT, PURPLE])
  expect(bands(4)).toEqual([ASSISTANT, null])
  expect(bands(5)).toEqual([null, PURPLE])
  // every record is still drawn, those of "user" with no edge
  const cards = () => [...el.querySelectorAll<HTMLElement>('.reader-record')]
  expect(cards().map((c) => c.dataset.line)).toEqual(['1', '2', '3', '4', '5'])
  expect(cards()[0].querySelector('.reader-bands')).toBeNull()
  expect(cards()[0].classList.contains('has-cb')).toBe(false)
  expect(cards()[1].classList.contains('has-cb')).toBe(true)
  // "assistant" alone: its records keep their color, and every other record stays, without one
  await act(async () => got!.toggle('assistant', true))
  expect(got!.off).toContain('user')
  expect(cards()).toHaveLength(5)
  expect(bands(2)).toEqual([ASSISTANT, PURPLE])
  expect(bands(1)).toEqual([null, null])
  // every value on again
  await act(async () => got!.toggle('assistant', true))
  expect(got!.off).toEqual([])
  expect(bands(1)).toEqual([USER, null])
  expect(cards()).toHaveLength(5)
})

test("with a label first, a record of a highlighted value takes the value's color as a tint across its row, and its hover names the label, its value and the text it marks; a key first tints nothing", async () => {
  const marked = new Map(ROWS)
  marked.set(`${PATH}#L2`, new Map([['a', { ...row(2, 'tactic'), spans: ['git push --force'] }]]))
  writeColor('w', PATH, { by: 'l:a', picks: ['l:a', 'k:type'], off: {} })
  function Records() {
    got = useColorBy('w', PATH, true, labels, RECORDS, marked, 5)
    return (
      <ColorContext.Provider value={got.colors}>
        {RECORDS.map((r) => (
          <RecordCard key={r.line} path={PATH} line={r.line} target={null} hit={false} header="turn">
            words
          </RecordCard>
        ))}
      </ColorContext.Provider>
    )
  }
  const el = await mount(<Records />)
  await settle()
  const cards = () => [...el.querySelectorAll<HTMLElement>('.reader-record')]
  expect(got!.colors!.get(2)!.tint).toBe(PURPLE)
  expect(cards()[1].classList.contains('has-cb-tint')).toBe(true)
  expect(cards()[1].style.getPropertyValue('--cb-tint')).toBe(PURPLE)
  expect(cards()[1].title).toBe('tactic: tactic\n“git push --force”')
  // "other" is no highlighted value: no tint, but its hover still says what the label gave it
  expect(cards()[3].classList.contains('has-cb-tint')).toBe(false)
  expect(cards()[3].title).toBe('tactic: other')
  // a record the label never read: neither
  expect(cards()[0].classList.contains('has-cb-tint')).toBe(false)
  expect(cards()[0].title).toBe('')
  // a value turned off takes its tint off too
  await act(async () => got!.toggle('tactic', false))
  expect(cards()[1].classList.contains('has-cb-tint')).toBe(false)
  // a key first: the bands only
  await act(async () => got!.toggle('tactic', false))
  writeColor('w', PATH, { by: 'k:type', picks: ['k:type'], off: {} })
  unmountAll()
  const k = await mount(<Records />)
  await settle()
  expect(k.querySelector('.has-cb-tint')).toBeNull()
  expect(got!.colors!.get(2)!.tint).toBeNull()
})
