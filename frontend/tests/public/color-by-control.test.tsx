// @vitest-environment jsdom
// The Color by control of Files' Transcript mode (src/files/ColorBy.tsx): the trigger says "Color by: <choice>"; its
// menu offers Off, the records' keys and the labels that mark the file; Off draws no chips; a chip turns its value off
// and on (Alt keeps it alone); choosing a label closes the menu and opens the label's editor under the trigger
// (LabelEditor), which Escape closes with the focus back on the trigger, while a key or Off opens nothing, and there is
// no info button; each key and label in the menu says how many values it has and shows them as chips on a line under
// its name; a click on a chip's swatch opens the palette of the twelve label colors, its own ringed, without turning the
// value off, and a pick or Reset colors goes to the reader.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { ColorBy } from '../../src/files/ColorBy'
import { labelChips, type ColorChoice } from '../../src/files/colorChoice'
import { LABEL_WHEEL } from '../../src/files/labels'
import { closeLabelEditor, LabelEditorHost } from '../../src/files/LabelEditor'
import type { Concept, SourceKey } from '../../src/lib/types'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  act(() => closeLabelEditor())
  unmountAll()
  vi.unstubAllGlobals()
})

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

test("choosing a label closes the menu and opens its editor under the trigger; Escape gives the focus back to the trigger", async () => {
  // the editor reads the labels itself
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(String(url), 'http://thimble.test').pathname
    const body = path.endsWith('/concepts') ? [label] : path.endsWith('/labels/presence') ? [] : null
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
  })
  const picked: ColorChoice[] = []
  const el = await draw({ by: 'key', key: 'wiki' }, picked)
  await mount(<LabelEditorHost ws="w" />)
  const trigger = el.querySelector<HTMLButtonElement>('.colorby-trigger')!
  await click(trigger)
  const row = [...document.querySelectorAll('.colorby-menu [role="menuitemradio"]')].find((r) => r.querySelector('.menu-item-label')?.textContent === 'edit purpose')!
  await click(row)
  await settle()
  expect(picked).toEqual([{ by: 'label', id: 'c1' }])
  expect(document.querySelector('.colorby-menu'), 'the menu closed').toBeNull()
  const pop = document.querySelector<HTMLElement>('.popover.label-editor-pop')!
  expect(pop.getAttribute('aria-label')).toBe('Edit edit purpose')
  expect(pop.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.value).toBe(label.description)
  await act(async () => new Promise((r) => setTimeout(r, 40)))
  await act(async () => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.popover.label-editor-pop')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('a key or Off opens no editor, and there is no info button beside the trigger or in the menu', async () => {
  const picked: ColorChoice[] = []
  const el = await draw({ by: 'label', id: 'c1' }, picked)
  await mount(<LabelEditorHost ws="w" />)
  expect(el.querySelector('.colorby-trigger')?.textContent).toBe('Color by: edit purpose')
  expect([...el.querySelectorAll('.colorby-chip')].map((c) => c.querySelector('.colorby-name')?.textContent)).toEqual(['posts links', 'other', 'Not marked'])
  expect(el.querySelector('.colorby-info')).toBeNull()
  for (const name of ['wiki', 'Off']) {
    await click(el.querySelector('.colorby-trigger')!)
    expect(document.querySelector('.colorby-menu .colorby-info, .colorby-menu .colorby-def')).toBeNull()
    await click([...document.querySelectorAll('.colorby-menu [role="menuitemradio"]')].find((r) => r.querySelector('.menu-item-label')?.textContent === name)!)
  }
  expect(picked).toEqual([{ by: 'key', key: 'wiki' }, { by: 'off' }])
  expect(document.querySelector('.popover.label-editor-pop')).toBeNull()
})

test("a chip's swatch opens the palette of every label color around the color wheel, its own ringed, and a pick goes to the reader", async () => {
  const toggled: [string, boolean][] = []
  const colored: [string, number][] = []
  let resets = 0
  const el = await draw({ by: 'key', key: 'wiki' }, [], toggled, colored, () => resets++)
  const chips = [...el.querySelectorAll('.colorby-chip')]
  await click(chips[0].querySelector('.colorby-sw')!)
  expect(toggled).toEqual([])
  const picks = [...document.querySelectorAll('.colorby-palette .colorby-pick')]
  // red, orange, gold, green, teal, sky, blue, purple, pink, a light and a dark of each
  expect(picks.map((b) => b.getAttribute('aria-label'))).toEqual(LABEL_WHEEL.flat().map((n) => `Color ${n}`))
  expect(picks.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label'))).toEqual(['Color 1'])
  expect(document.querySelector('.colorby-palette .colorby-palette-head')?.textContent).toBe('dse')
  await click(picks.find((b) => b.getAttribute('aria-label') === 'Color 13')!)
  expect(colored).toEqual([['dse', 13]])
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
