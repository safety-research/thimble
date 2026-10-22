// @vitest-environment jsdom
// A record's left edge under Color by in Files' Transcript and Table modes (src/files/useColorBy.ts, colorContext.ts,
// views/common.tsx EdgeBands): a band per choice, in the tracks' order, each in the color of the record's value of that
// choice, as its lane of the tracks colors it: a key's value in its colors, a label's highlighted value in the label's.
// A record with no value of a choice has no band there, an empty place and not gray; a record with a value of any
// choice has its bands; Off has none. A value turned off takes its color off its records, which stay drawn. The bands
// of one set of colors are one array, so a row given them keeps its props. How the bands look in a browser is
// tests/public/browser/color-bands.test.ts.
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { colourVar } from '../../src/files/labels'
import { keyColor, writeColor, type ColorChoice } from '../../src/files/colorChoice'
import { bandsOf, ColorContext, type RecordColor } from '../../src/files/colorContext'
import { useColorBy, type ColorBy } from '../../src/files/useColorBy'
import type { FilesLabels } from '../../src/files/useLabels'
import { bandWidth, BAND_GAP_PX, EdgeBands, RecordCard } from '../../src/files/views/common'
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

test('a key as the second choice: its values in its own colors, those picked for it too; a record without the key has no band there', async () => {
  writeColor('w', PATH, { by: 'l:a', picks: ['l:a', 'k:tool'], off: {}, colors: { 'k:tool': { Bash: 7 } } })
  const recs = RECORDS.map((r, i) => (i === 1 ? ({ ...r, record: { ...(r.record as object), tool: 'Bash' } } as SourceRecord) : r))
  function H() {
    got = useColorBy('w', PATH, true, labels, recs, ROWS, 5)
    return null
  }
  await mount(<H />)
  await settle()
  expect(bands(2)).toEqual([PURPLE, 'var(--label-7)'])
  expect(bands(1)).toEqual([null, null])
  expect(got!.colors!.get(1)!.bands.some(Boolean)).toBe(false)
})

test('one choice is one band, as the one bar was; Off gives no colors', async () => {
  writeColor('w', PATH, { by: 'k:type', picks: ['k:type'], off: {} })
  await mount(<Harness />)
  await settle()
  expect(bands(2)).toEqual([ASSISTANT])
  await act(async () => got!.choose({ by: 'off' }))
  expect(got!.colors).toBeNull()
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

/** A record drawn with the colors `colors` give its line. */
function Card({ colors, line }: { colors: ReadonlyMap<number, RecordColor> | null; line: number }) {
  return (
    <ColorContext.Provider value={colors}>
      <RecordCard path={PATH} line={line} target={null} hit={false} header="user">
        words
      </RecordCard>
    </ColorContext.Provider>
  )
}
const drawn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.reader-band')].map((b) => (b.classList.contains('is-empty') ? null : b.style.background))

test("a record's edge draws its bands side by side from the left, an empty place where it has no value; Off draws none", async () => {
  const colors = new Map<number, RecordColor>([
    [1, { color: 'rgb(1, 2, 3)', bands: bandsOf(['rgb(1, 2, 3)', 'rgb(4, 5, 6)']) }],
    [2, { color: 'rgb(1, 2, 3)', bands: bandsOf(['rgb(1, 2, 3)', null]) }],
    [3, { color: null, bands: bandsOf([null, 'rgb(4, 5, 6)']) }],
    [4, { color: null, bands: bandsOf([null, null]) }],
  ])
  const two = await mount(<Card colors={colors} line={1} />)
  expect(drawn(two)).toEqual(['rgb(1, 2, 3)', 'rgb(4, 5, 6)'])
  expect(two.querySelector('.reader-record')!.classList.contains('has-cb')).toBe(true)
  expect(two.querySelector<HTMLElement>('.reader-bands')!.style.getPropertyValue('--band-w')).toBe('3px')
  const gap = await mount(<Card colors={colors} line={2} />)
  expect(drawn(gap)).toEqual(['rgb(1, 2, 3)', null])
  const first = await mount(<Card colors={colors} line={3} />)
  expect(drawn(first)).toEqual([null, 'rgb(4, 5, 6)'])
  // no value of any choice, and Color by Off: no bands, no edge
  for (const el of [await mount(<Card colors={colors} line={4} />), await mount(<Card colors={null} line={1} />)]) {
    expect(el.querySelector('.reader-bands')).toBeNull()
    expect(el.querySelector('.reader-record')!.classList.contains('has-cb')).toBe(false)
  }
})

test('the bands keep within the room of the one bar and its gap, narrower as more come', async () => {
  expect([1, 2, 3, 4, 5].map(bandWidth)).toEqual([3, 3, 2, 1, 1])
  for (const n of [1, 2, 3, 4, 5]) expect(n * bandWidth(n) + (n - 1) * BAND_GAP_PX).toBeLessThanOrEqual(9)
  const el = await mount(<EdgeBands bands={bandsOf(['red', 'blue', 'green'])} />)
  expect(el.querySelector<HTMLElement>('.reader-bands')!.style.getPropertyValue('--band-w')).toBe('2px')
  function Toggle() {
    const [b, setB] = useState<readonly (string | null)[] | null>(null)
    ;(globalThis as { __set?: typeof setB }).__set = setB
    return <EdgeBands bands={b} />
  }
  const t = await mount(<Toggle />)
  expect(t.querySelector('.reader-bands')).toBeNull()
  await act(async () => (globalThis as { __set?: (b: readonly (string | null)[]) => void }).__set!([null, null]))
  expect(t.querySelector('.reader-bands')).toBeNull()
})
