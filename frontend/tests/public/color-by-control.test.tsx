// @vitest-environment jsdom
// The Color by control of Files' Transcript mode (src/files/ColorBy.tsx): the trigger says "Color by: <choice>"; its
// menu offers Off, the records' keys and the labels that mark the file; Off draws no chips; a chip turns its value off
// and on (Alt keeps it alone); a label's info button in the menu opens its definition in place, its question and each
// value with its meaning, and Open label opens it in the Labels pane; while a label is the choice an info button beside
// the trigger opens the same; each key and label in the menu says how many values it has and shows them as chips on a
// line under its name; a click on a chip's swatch opens the palette of the twelve label colors, its own ringed,
// without turning the value off, and a pick or Reset colors goes to the reader.
import { act } from 'react'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { ColorBy } from '../../src/files/ColorBy'
import { labelChips, type ColorChoice } from '../../src/files/colorChoice'
import { bus } from '../../src/lib/bus'
import type { Concept, SourceKey } from '../../src/lib/types'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(unmountAll)

const keys: SourceKey[] = [
  {
    key: 'wiki',
    values: [
      { value: 'dse', n: 9 },
      { value: 'probier', n: 3 },
    ],
    more: { values: 0, n: 0 },
    none: 0,
    at: [],
  },
]
const label: Concept = {
  id: 'c1',
  name: 'edit purpose',
  description: "What this edit adds. 'posts links': the edit adds links. 'other': anything else.",
  unit: 'record',
  kind: 'prompt',
  spec: '',
  labels: ['posts links', 'other'],
  created_by: 'orient',
  ts: '',
  glob: 'revisions.jsonl',
  n_labeled: 12,
  classes: [
    { name: 'posts links', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: true },
  ],
}
const counts = { 'posts links': 8, other: 4 }

async function draw(choice: ColorChoice, picked: ColorChoice[] = [], toggled: [string, boolean][] = [], colored?: [string, number][], reset?: () => void) {
  const values =
    choice.by === 'label'
      ? labelChips(label, counts, 20)
      : choice.by === 'key'
        ? [
            { id: 'dse', name: 'dse', n: 9, color: 'var(--label-1)' },
            { id: 'probier', name: 'probier', n: 3, color: 'var(--label-2)' },
          ]
        : []
  return mount(<ColorBy choice={choice} keys={keys} labels={[label]} values={values} off={['probier']} onChoose={(c) => picked.push(c)} onToggle={(v, alone) => toggled.push([v, alone])} countsOf={() => counts} onColor={colored ? (v, n) => colored.push([v, n]) : undefined} onResetColors={reset} />)
}

const click = async (el: Element, init: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })))

test('the trigger names the choice and the menu offers Off, the keys and the labels', async () => {
  const picked: ColorChoice[] = []
  const el = await draw({ by: 'key', key: 'wiki' }, picked)
  expect(el.querySelector('.colorby-trigger')?.textContent).toBe('Color by: wiki')
  await click(el.querySelector('.colorby-trigger')!)
  const items = [...document.querySelectorAll('.colorby-menu [role="menuitemradio"]')]
  expect(items.map((b) => b.querySelector('.menu-item-label')?.textContent)).toEqual(['Off', 'wiki', 'edit purpose'])
  expect(items[1].getAttribute('aria-checked')).toBe('true')
  await click(items[0])
  expect(picked).toEqual([{ by: 'off' }])
})

test('Off draws no chips', async () => {
  const el = await draw({ by: 'off' })
  expect(el.querySelector('.colorby-trigger')?.textContent).toBe('Color by: Off')
  expect(el.querySelectorAll('.colorby-chip')).toHaveLength(0)
})

test('a chip turns its value off and on, and Alt keeps it alone', async () => {
  const toggled: [string, boolean][] = []
  const el = await draw({ by: 'key', key: 'wiki' }, [], toggled)
  const chips = [...el.querySelectorAll('.colorby-chip')]
  expect(chips.map((c) => [c.textContent, c.getAttribute('aria-pressed')])).toEqual([
    ['dse9', 'true'],
    ['probier3', 'false'],
  ])
  await click(chips[1])
  await click(chips[0], { altKey: true })
  expect(toggled).toEqual([
    ['probier', false],
    ['dse', true],
  ])
})

test("a label's definition opens in place in the menu, and Open label opens it in the Labels pane", async () => {
  const opened: string[] = []
  const off = bus.on('editLabel', ({ id }) => opened.push(id))
  const el = await draw({ by: 'key', key: 'wiki' })
  await click(el.querySelector('.colorby-trigger')!)
  await click(document.querySelector('.colorby-menu .colorby-info')!)
  const def = document.querySelector('.colorby-menu .colorby-def')!
  expect(def.querySelector('.colorby-def-text')?.textContent).toBe('What this edit adds.')
  expect([...def.querySelectorAll('.colorby-def-values li')].map((li) => [li.querySelector('.colorby-def-value')?.textContent, li.querySelector('.colorby-def-meaning')?.textContent])).toEqual([
    ['posts links', 'the edit adds links.'],
    ['other', 'anything else.'],
  ])
  await click([...def.querySelectorAll('button')].find((b) => b.textContent === 'Open label')!)
  off()
  expect(opened).toEqual(['c1'])
})

test('while a label is the choice, the info button beside the trigger opens its definition', async () => {
  const el = await draw({ by: 'label', id: 'c1' })
  expect(el.querySelector('.colorby-trigger')?.textContent).toBe('Color by: edit purpose')
  expect([...el.querySelectorAll('.colorby-chip')].map((c) => c.querySelector('.colorby-name')?.textContent)).toEqual(['posts links', 'other', 'Not marked'])
  await click(el.querySelector('.colorby > .colorby-info')!)
  expect(document.querySelector('.colorby-infopop .colorby-def-name')?.textContent).toBe('edit purpose')
})

test("a chip's swatch opens the palette of the twelve label colors, its own ringed, and a pick goes to the reader", async () => {
  const toggled: [string, boolean][] = []
  const colored: [string, number][] = []
  let resets = 0
  const el = await draw({ by: 'key', key: 'wiki' }, [], toggled, colored, () => resets++)
  const chips = [...el.querySelectorAll('.colorby-chip')]
  await click(chips[0].querySelector('.colorby-sw')!)
  expect(toggled).toEqual([])
  const picks = [...document.querySelectorAll('.colorby-palette .colorby-pick')]
  expect(picks).toHaveLength(12)
  expect(picks.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', ...Array(11).fill('false')])
  expect(document.querySelector('.colorby-palette .colorby-palette-head')?.textContent).toBe('dse')
  await click(picks[6])
  expect(colored).toEqual([['dse', 7]])
  expect(document.querySelector('.colorby-palette .colorby-pick')).toBeNull()
  // Reset colors
  await click(chips[1].querySelector('.colorby-sw')!)
  await click([...document.querySelectorAll('.colorby-palette button')].find((b) => b.textContent === 'Reset colors')!)
  expect(resets).toBe(1)
  // the chip itself still turns its value off and on
  await click(chips[1])
  expect(toggled).toEqual([['probier', false]])
})

test("the records a label does not mark have no color to pick, and without a reader's recolor there is no palette", async () => {
  const el = await draw({ by: 'label', id: 'c1' }, [], [], [])
  const swatches = [...el.querySelectorAll('.colorby-chip')].map((c) => c.querySelector('.colorby-sw')!.hasAttribute('data-palette'))
  expect(swatches).toEqual([true, true, false])
  unmountAll()
  const plain = await draw({ by: 'key', key: 'wiki' })
  expect(plain.querySelector('.colorby-sw[data-palette]')).toBeNull()
})

test('each key and label in the menu says how many values it has, and shows them as chips on the line under its name', async () => {
  const el = await draw({ by: 'off' })
  await click(el.querySelector('.colorby-trigger')!)
  const rows = [...document.querySelectorAll('.colorby-menu [role="menuitemradio"]')].slice(1)
  expect(rows.map((r) => [r.querySelector('.menu-item-label')?.textContent, r.querySelector('.menu-item-note')?.textContent, [...r.querySelectorAll('.colorby-preview-chip')].map((c) => c.textContent)])).toEqual([
    ['wiki', '2 values', ['dse', 'probier']],
    ['edit purpose', '2 values', ['posts links', 'other']],
  ])
  // each chip a square swatch of its value's color
  expect((rows[0].querySelector('.colorby-preview-chip') as HTMLElement).style.getPropertyValue('--c')).toBe('var(--label-1)')
})

test('a choice of one value says "1 value"', async () => {
  const { valuesWord } = await import('../../src/files/ColorBy')
  expect([valuesWord(1), valuesWord(3), valuesWord(1200)]).toEqual(['1 value', '3 values', '1,200 values'])
})
