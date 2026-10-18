// @vitest-environment jsdom
// The label editor (src/files/LabelEditor.tsx): Files' Labels sidebar and the popover a view opens over itself draw the
// one editor, LabelCard, with the same fields, prompt, classes and actions. A label that exists opens compact: its name,
// its type and scope, its prompt clamped until it has the focus, its classes, and More folded over the rest, which stays
// as the analyst left it for the page's session; Cancel and Re-run show once something changed. A new label shows every
// field. The popover sits beside what asked for it,
// takes the focus, and Escape, Cancel or × close it, giving the focus back and telling the opener; a second request
// takes the first one's place. A view's edit call (labelCalls.ts) hands the editor the rect the page gave, in the page's
// coordinates, and a view's label controls (ViewPane) open it with what a new label applies to. A class's swatch opens
// the palette Color by's chips open (ValuePalette), whose pick for a saved value goes through setColour, and whose
// Escape closes the palette alone.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ViewLabelActions } from '../../src/files/labelCalls.ts'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { Concept } from '../../src/lib/types.ts'
import { LABEL_WHEEL } from '../../src/files/labels.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let viewActions: ViewLabelActions | undefined
vi.mock('../../src/files/ViewerFrame', () => ({
  ViewerFrame: (p: { labelActions?: ViewLabelActions }) => {
    viewActions = p.labelActions
    return <div className="stub-frame" />
  },
}))

const { closeLabelEditor, EDITOR_WIDTH, LabelEditorHost, openLabelEditor } = await import('../../src/files/LabelEditor.tsx')
const { frameAnchor } = await import('../../src/files/labelCalls.ts')
const { useLabelRuns, useLabelSide } = await import('../../src/files/ViewSide.tsx')
const { ViewPane } = await import('../../src/files/ViewPane.tsx')

const kind = {
  id: 'k1',
  name: 'activity type',
  description: 'What the agent is doing in this message.',
  unit: 'record',
  kind: 'prompt',
  spec: '',
  glob: 'transcript.jsonl',
  marks: 'record',
  n_labeled: 1815,
  labels: ['reading', 'writing', 'other'],
  created_by: 'analyst',
  ts: '',
  shown: true,
  classes: [
    { name: 'reading', color: 1, highlight: true },
    { name: 'writing', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
} as unknown as Concept

const labels: FilesLabels = {
  all: [kind],
  on: [kind],
  focus: kind.id,
  setFocus: () => undefined,
  byId: new Map([[kind.id, kind]]),
  presence: new Map(),
  toggle: () => undefined,
  setClasses: () => undefined,
  setColour: vi.fn(),
  save: async () => kind,
  remove: vi.fn(async () => undefined),
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  // the popover reads the labels itself, as a label's popover on a card does
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(String(url), 'http://thimble.test').pathname
    const body = path.endsWith('/concepts') ? [kind] : path.endsWith('/labels/presence') ? [] : path.endsWith('/labels/glob') ? { files: ['transcript.jsonl'], total: 1 } : null
    // what else is asked (the settings, a view's notes) is not there
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  act(() => closeLabelEditor())
  unmountAll()
  vi.unstubAllGlobals()
})

/** The sidebar's editor, as Files places it at the Labels pane's edge. */
function SideCard({ editing, of = labels }: { editing: string | 'new'; of?: FilesLabels }) {
  const runs = useLabelRuns('w', of)
  const { card } = useLabelSide({ ws: 'w', labels: of, runs, open: true, onToggleOpen: () => undefined, editing, onEdit: () => undefined, drafted: null, onDraft: () => undefined, appliesTo: ['transcript.jsonl'], width: 250, onWidth: () => undefined, onWidthEnd: () => undefined, maxWidth: 400 })
  return <div className="side">{card}</div>
}

/** What a card shows: its field names, name, prompt, classes and the foot's actions. */
const shape = (card: Element) => ({
  keys: [...card.querySelectorAll('.label-card-key')].map((e) => e.textContent),
  facts: [...card.querySelectorAll('.label-card-fact')].map((e) => e.textContent),
  name: card.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value,
  prompt: card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.value,
  classes: [...card.querySelectorAll<HTMLInputElement>('[aria-label="Class name"]')].map((e) => e.value),
  switches: card.querySelectorAll('[role="switch"]').length,
  foot: [...card.querySelectorAll('.label-card-foot button')].map((b) => b.textContent?.trim()),
})

const popover = () => document.querySelector<HTMLElement>('.popover.label-editor-pop')

/** A control to open the editor beside, and to give the focus back to. */
function control(): HTMLButtonElement {
  const b = document.body.appendChild(document.createElement('button'))
  b.textContent = 'activity type'
  return b
}

describe('one label editor in the sidebar and in the popover', () => {
  test('both draw LabelCard with the same fields, prompt, classes and actions', async () => {
    const el = await mount(
      <>
        <SideCard editing="k1" />
        <LabelEditorHost ws="w" />
      </>,
    )
    const at = control()
    await act(async () => openLabelEditor({ id: 'k1', anchor: at }))
    await settle()
    const side = el.querySelector('.side .label-card')!
    const pop = popover()!
    const inPop = pop.querySelector('.label-card')!
    // compact: the type and scope, the prompt and the classes; no highlight switch and no foot until something changes
    expect(shape(inPop)).toEqual(shape(side))
    expect(shape(inPop)).toEqual({ keys: ['Type', 'Scope'], facts: ['Prompt', 'transcript.jsonl · 1,815 records'], name: 'activity type', prompt: 'What the agent is doing in this message.', classes: ['reading', 'writing', 'other'], switches: 0, foot: [] })
    for (const card of [side, inPop]) {
      expect(card.querySelector('.label-card-more')?.getAttribute('aria-expanded')).toBe('false')
      expect(card.querySelector('.label-card-head [aria-label="Close"]')).not.toBeNull()
      // a multi-class label has no color of its own: its glyph, and its name in the ink
      expect(card.querySelector<HTMLInputElement>('[aria-label="Name"]')!.style.color).toBe('')
      expect(card.querySelector('.label-card-tag')).not.toBeNull()
    }
    // the sidebar's card is its own dialog on the overlay's paper; in the popover, the popover is both, at the card's width
    expect([side.classList.contains('overlay'), side.getAttribute('role'), side.getAttribute('aria-label')]).toEqual([true, 'dialog', 'Edit activity type'])
    expect([inPop.classList.contains('overlay'), inPop.classList.contains('in-popover'), inPop.getAttribute('role')]).toEqual([false, true, null])
    expect([pop.getAttribute('role'), pop.getAttribute('aria-label'), pop.style.width]).toEqual(['dialog', 'Edit activity type', `${EDITOR_WIDTH}px`])
  })
})

describe("a class's swatch", () => {
  const swatch = (root: ParentNode, name: string) => root.querySelector<HTMLButtonElement>(`[aria-label="Change the color of ${name}"]`)!
  const palette = () => document.querySelector<HTMLElement>('.popover.colorby-palette')

  test("opens the value palette, the class's color ringed; a pick for a saved value goes through setColour", async () => {
    const setColour = labels.setColour as ReturnType<typeof vi.fn>
    setColour.mockClear()
    const el = await mount(<SideCard editing="k1" />)
    await act(async () => swatch(el, 'writing').click())
    const picks = [...palette()!.querySelectorAll('.colorby-pick')]
    expect(picks.map((b) => b.getAttribute('aria-label'))).toEqual([...LABEL_WHEEL.flat().map((n) => `Color ${n}`), 'Gray'])
    expect(picks.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label'))).toEqual(['Color 2'])
    expect(palette()!.querySelector('.colorby-palette-head')?.textContent).toBe('writing')
    await act(async () => (picks.find((b) => b.getAttribute('aria-label') === 'Color 5') as HTMLButtonElement).click())
    expect(setColour.mock.calls).toEqual([['k1', 'writing', 5]])
    expect(palette()).toBeNull()
  })
})

test("a view's label controls open the editor over the view, a new label applying to the files the view claims", async () => {
  const view = { slug: 'timeline', name: 'Activity Timeline', version: 'v1', n_files: 1, files: ['transcript.jsonl'], first_file: 'transcript.jsonl', claims: ['transcript.jsonl'] }
  await mount(
    <>
      <ViewPane ws="w" view={view as never} path="transcript.jsonl" labels={labels} />
      <LabelEditorHost ws="w" />
    </>,
  )
  await settle()
  const f = document.createElement('iframe')
  document.body.appendChild(f)
  const closed = vi.fn()
  await act(async () => viewActions!.edit!(null, { anchor: frameAnchor(f, null), side: 'below', back: f, onClose: closed }))
  await settle()
  expect(popover()!.querySelector<HTMLInputElement>('[aria-label="Applies to"]')?.value).toBe('transcript.jsonl')
  expect(document.querySelector('aside.files-side-labels'), 'no sidebar opens').toBeNull()
  await act(async () => closeLabelEditor())
  expect(closed).toHaveBeenCalledTimes(1)
})
