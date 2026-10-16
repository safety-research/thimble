// @vitest-environment jsdom
// The Color by control of Files' Transcript mode (src/files/ColorBy.tsx), as a view's Color by: the trigger says
// "Color by: <first choice>" and "+N" for the choices past it; its menu offers Off, then the records' keys under
// "Fields" and the labels that mark the file under "Labels", each a checkbox, the first checked the color and each one
// after it saying "track"; a click on a key or a label checks or unchecks it and leaves the menu open, Off closes it; Off
// draws no chips; a chip turns its value off and on (Alt keeps it alone); checking a label opens its editor beside its
// row (LabelEditor), which Escape closes with the focus back on the row, a second Escape closing the menu with the
// focus on the trigger, while a key, Off or unchecking a label opens nothing, and there is no info button; each key and
// label in the menu says how many values it has and shows them as chips on a line under its name; a click on a chip's
// swatch opens the palette of the label colors, its own ringed, without turning the value off, and a pick or Reset colors
// goes to the reader.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { ColorBy } from '../../src/files/ColorBy'
import { labelChips, type ColorChoice } from '../../src/files/colorChoice'
import { closeLabelEditor } from '../../src/files/LabelEditor'
import type { Concept, SourceKey } from '../../src/lib/types'
import { mount, unmountAll } from './mount.tsx'

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

async function draw(choice: ColorChoice, picked: ColorChoice[] = [], toggled: [string, boolean][] = [], colored?: [string, number][], reset?: () => void, picks?: ColorChoice[]) {
  const values =
    choice.by === 'label'
      ? labelChips(label, counts, 20)
      : choice.by === 'key'
        ? [
            { id: 'dse', name: 'dse', n: 9, color: 'var(--label-1)' },
            { id: 'probier', name: 'probier', n: 3, color: 'var(--label-2)' },
          ]
        : []
  return mount(<ColorBy choice={choice} picks={picks} keys={keys} labels={[label]} values={values} off={['probier']} onChoose={(c) => picked.push(c)} onToggle={(v, alone) => toggled.push([v, alone])} countsOf={() => counts} onColor={colored ? (v, n) => colored.push([v, n]) : undefined} onResetColors={reset} />)
}

const click = async (el: Element, init: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })))

const rows = () => [...document.querySelectorAll('.colorby-menu .colorby-item')]
const rowNamed = (name: string) => rows().find((r) => r.querySelector('.menu-item-label')?.textContent === name)!

test('the trigger names the first choice and how many more; the menu offers Off, the keys under Fields and the labels under Labels, each a checkbox', async () => {
  const picked: ColorChoice[] = []
  const el = await draw({ by: 'key', key: 'wiki' }, picked)
  expect(el.querySelector('.colorby-trigger')?.textContent).toBe('Color by: wiki')
  await click(el.querySelector('.colorby-trigger')!)
  expect([...document.querySelectorAll('.colorby-menu .menu-heading')].map((h) => h.textContent)).toEqual(['Fields', 'Labels'])
  expect(rows().map((b) => [b.querySelector('.menu-item-label')?.textContent, b.getAttribute('role'), b.getAttribute('aria-checked')])).toEqual([
    ['Off', 'menuitemradio', 'false'],
    ['wiki', 'menuitemcheckbox', 'true'],
    ['edit purpose', 'menuitemcheckbox', 'false'],
  ])
  expect(rows().map((b) => !!b.querySelector('.colorby-box.on svg'))).toEqual([false, true, false])
  // a key checked or unchecked leaves the menu open; Off closes it
  await click(rowNamed('wiki'))
  expect(document.querySelector('.colorby-menu')).not.toBeNull()
  await click(rowNamed('Off'))
  expect(picked).toEqual([{ by: 'key', key: 'wiki' }, { by: 'off' }])
  expect(document.querySelector('.colorby-menu')).toBeNull()
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
