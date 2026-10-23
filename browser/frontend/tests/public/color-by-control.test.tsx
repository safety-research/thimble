// @vitest-environment jsdom
// The Color by control of Files' Transcript mode (src/files/ColorBy.tsx), as a view's Color by: the trigger says
// "Color by: <first choice>" and "+N" for the choices past it; its menu offers Off, then the records' keys under
// "Fields" and the labels that mark the file under "Labels", each a checkbox, the first checked the color and each one
// after it saying "track"; a chip turns its value off and on (Alt keeps it alone); checking a label opens its editor
// beside its row (LabelEditor), which Escape closes with the focus back on the row, a second Escape closing the menu
// with the focus on the trigger; a click on a chip's swatch opens the palette of the label colors, its own ringed,
// without turning the value off, and a pick goes to the reader.
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

test('a choice past the first is a track: "+1" in the trigger, which names it, and "track" after its name in the menu', async () => {
  const el = await draw({ by: 'key', key: 'wiki' }, [], [], undefined, undefined, [
    { by: 'key', key: 'wiki' },
    { by: 'label', id: 'c1' },
  ])
  const trigger = el.querySelector('.colorby-trigger')!
  expect(trigger.textContent).toBe('Color by: wiki+1')
  expect(trigger.querySelector('.colorby-plus')?.getAttribute('title')).toBe('edit purpose: a track each')
  await click(trigger)
  expect(rows().map((b) => [b.getAttribute('aria-checked'), b.querySelector('.colorby-track-n')?.textContent ?? null])).toEqual([
    ['false', null],
    ['true', null],
    ['true', 'track'],
  ])
  // with Off, nothing is checked but Off
  unmountAll()
  const off = await draw({ by: 'off' }, [], [], undefined, undefined, [])
  await click(off.querySelector('.colorby-trigger')!)
  expect(rows().map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
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

test("checking a label leaves the menu open and opens its editor beside the label's row; Escape gives the focus back to the row, a second Escape closes the menu", async () => {
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
  const row = rowNamed('edit purpose') as HTMLButtonElement
  await click(row)
  await settle()
  expect(picked).toEqual([{ by: 'label', id: 'c1' }])
  expect(document.querySelector('.colorby-menu'), 'the menu stays open').not.toBeNull()
  const pop = document.querySelector<HTMLElement>('.popover.label-editor-pop')!
  expect(pop.getAttribute('aria-label')).toBe('Edit edit purpose')
  expect(pop.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.value).toBe(label.description)
  await act(async () => new Promise((r) => setTimeout(r, 40)))
  await act(async () => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.popover.label-editor-pop')).toBeNull()
  expect(document.querySelector('.colorby-menu')).not.toBeNull()
  expect(document.activeElement).toBe(row)
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.colorby-menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
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

