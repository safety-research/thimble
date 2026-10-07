// @vitest-environment jsdom
// The label editor (src/files/LabelEditor.tsx): Files' Labels sidebar and the popover a view opens over itself draw the
// one editor, LabelCard, with the same fields, prompt, classes and actions. The popover sits beside what asked for it,
// takes the focus, and Escape, Cancel or × close it, giving the focus back and telling the opener; a second request
// takes the first one's place. A view's edit call (labelCalls.ts) hands the editor the rect the page gave, in the page's
// coordinates, and a view's label controls (ViewPane) open it with what a new label applies to.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ViewLabelActions } from '../../src/files/labelCalls.ts'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { Concept } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let viewActions: ViewLabelActions | undefined
vi.mock('../../src/files/ViewerFrame', () => ({
  ViewerFrame: (p: { labelActions?: ViewLabelActions }) => {
    viewActions = p.labelActions
    return <div className="stub-frame" />
  },
}))

const { closeLabelEditor, EDITOR_WIDTH, LabelEditorHost, openLabelEditor } = await import('../../src/files/LabelEditor.tsx')
const { frameAnchor, frameRect, runLabelCall } = await import('../../src/files/labelCalls.ts')
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
  setColour: () => undefined,
  save: async () => kind,
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
function SideCard({ editing }: { editing: string | 'new' }) {
  const runs = useLabelRuns('w', labels)
  const { card } = useLabelSide({ ws: 'w', labels, runs, open: true, onToggleOpen: () => undefined, editing, onEdit: () => undefined, drafted: null, onDraft: () => undefined, appliesTo: ['transcript.jsonl'], width: 250, onWidth: () => undefined, onWidthEnd: () => undefined, maxWidth: 400 })
  return <div className="side">{card}</div>
}

/** What a card shows: its field names, name, prompt, classes and the foot's actions. */
const shape = (card: Element) => ({
  keys: [...card.querySelectorAll('.label-card-key')].map((e) => e.textContent),
  name: card.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value,
  prompt: card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.value,
  classes: [...card.querySelectorAll<HTMLInputElement>('[aria-label="Class name"]')].map((e) => e.value),
  switches: card.querySelectorAll('[role="switch"]').length,
  foot: [...card.querySelectorAll('.label-card-foot button')].map((b) => b.textContent?.trim()),
})

const popover = () => document.querySelector<HTMLElement>('.popover.label-editor-pop')
const frames = () => new Promise((r) => setTimeout(r, 40))

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
    expect(shape(side).keys).toEqual(['Over', 'Marks', 'Applies to', 'Classifier', 'Model', 'Classes'])
    expect(shape(inPop)).toEqual(shape(side))
    expect(shape(inPop)).toMatchObject({ name: 'activity type', prompt: 'What the agent is doing in this message.', classes: ['reading', 'writing', 'other'], switches: 3, foot: ['Cancel', 'Re-run'] })
    // the sidebar's card is its own dialog on the overlay's paper; in the popover, the popover is both, at the card's width
    expect([side.classList.contains('overlay'), side.getAttribute('role'), side.getAttribute('aria-label')]).toEqual([true, 'dialog', 'Edit activity type'])
    expect([inPop.classList.contains('overlay'), inPop.classList.contains('in-popover'), inPop.getAttribute('role')]).toEqual([false, true, null])
    expect([pop.getAttribute('role'), pop.getAttribute('aria-label'), pop.style.width]).toEqual(['dialog', 'Edit activity type', `${EDITOR_WIDTH}px`])
  })

  test("a new label's editor has Label from prompt above it in both", async () => {
    const el = await mount(
      <>
        <SideCard editing="new" />
        <LabelEditorHost ws="w" />
      </>,
    )
    await act(async () => openLabelEditor({ id: null, anchor: control(), appliesTo: ['transcript.jsonl'] }))
    await settle()
    for (const card of [el.querySelector('.side .label-card')!, popover()!.querySelector('.label-card')!]) {
      expect(card.querySelector('[aria-label="Label from prompt"]')).not.toBeNull()
      expect(card.querySelector<HTMLInputElement>('[aria-label="Applies to"]')?.value).toBe('transcript.jsonl')
      expect(shape(card).foot).toEqual(['Cancel', 'Run'])
    }
    expect(popover()!.getAttribute('aria-label')).toBe('New label')
  })
})

describe('the popover', () => {
  test('takes the focus; Escape closes it, gives the focus back and tells the opener', async () => {
    await mount(<LabelEditorHost ws="w" />)
    const at = control()
    const closed = vi.fn()
    await act(async () => openLabelEditor({ id: 'k1', anchor: at, back: at, onClose: closed }))
    await act(frames)
    expect(popover()!.contains(document.activeElement), 'the focus is in the popover').toBe(true)
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(at)
    expect(closed.mock.calls).toEqual([[true]])
  })

  test('Cancel and × close it too', async () => {
    await mount(<LabelEditorHost ws="w" />)
    const at = control()
    for (const name of ['Cancel', 'Close']) {
      const closed = vi.fn()
      await act(async () => openLabelEditor({ id: 'k1', anchor: at, back: at, onClose: closed }))
      await act(frames)
      const button = [...popover()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!
      button.focus()
      await act(async () => button.click())
      expect(popover(), name).toBeNull()
      expect(document.activeElement, name).toBe(at)
      expect(closed.mock.calls, name).toEqual([[true]])
    }
  })

  test('a click outside closes it and leaves the focus where the click put it', async () => {
    await mount(<LabelEditorHost ws="w" />)
    const at = control()
    const other = control()
    const closed = vi.fn()
    await act(async () => openLabelEditor({ id: 'k1', anchor: at, back: at, onClose: closed }))
    await act(frames)
    // the button the analyst presses takes the focus as the press ends
    other.addEventListener('mousedown', () => queueMicrotask(() => other.focus()))
    await act(async () => void other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(other)
    expect(closed.mock.calls).toEqual([[false]])
  })

  test("a second request takes the first one's place, and the first hears it closed", async () => {
    await mount(<LabelEditorHost ws="w" />)
    const first = vi.fn()
    const second = vi.fn()
    await act(async () => openLabelEditor({ id: 'k1', anchor: control(), onClose: first }))
    await act(async () => openLabelEditor({ id: null, anchor: control(), onClose: second }))
    await settle()
    expect(first.mock.calls).toEqual([[false]])
    expect(second).not.toHaveBeenCalled()
    expect(document.querySelectorAll('.popover.label-editor-pop').length).toBe(1)
    expect(popover()!.getAttribute('aria-label')).toBe('New label')
  })

  test('it stays where it stood when the control it stands beside leaves the page', async () => {
    await mount(<LabelEditorHost ws="w" />)
    const at = control()
    // a control out of the page has no box, as a browser gives it
    at.getBoundingClientRect = () => (at.isConnected ? new DOMRect(100, 100, 50, 20) : new DOMRect(0, 0, 0, 0))
    await act(async () => openLabelEditor({ id: 'k1', anchor: at, side: 'below' }))
    await settle()
    const where = () => [popover()!.style.left, popover()!.style.top]
    expect(where()).toEqual(['100px', '124px'])
    at.remove()
    await act(async () => void window.dispatchEvent(new Event('resize')))
    expect(where()).toEqual(['100px', '124px'])
  })

  test('a label the labels do not hold closes it once they are read', async () => {
    await mount(<LabelEditorHost ws="w" />)
    const closed = vi.fn()
    await act(async () => openLabelEditor({ id: 'gone', anchor: control(), onClose: closed }))
    await settle()
    expect(popover()).toBeNull()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe("a view's edit call", () => {
  const frame = () => {
    const f = document.createElement('iframe')
    f.getBoundingClientRect = () => new DOMRect(100, 50, 600, 400)
    return f
  }
  const ctx = (f: HTMLIFrameElement, edit: NonNullable<ViewLabelActions['edit']>, onEditorClosed?: () => void) => ({ ws: 'w', byId: labels.byId, palette: [], actions: { setOn: () => undefined, setColour: () => undefined, edit }, frame: f, onEditorClosed })
  const box = (r: DOMRect) => [r.left, r.top, r.width, r.height]

  test("places the editor beside the page's rect, in this page's coordinates, and tells the page when it closes", async () => {
    const f = frame()
    const got: unknown[] = []
    const closed = vi.fn()
    let close: (focused: boolean) => void = () => undefined
    await runLabelCall(
      'edit',
      { id: 'activity type', anchor: { left: 10, top: 20, width: 30, height: 12 } },
      ctx(
        f,
        (id, at) => {
          got.push([id, at && box(at.anchor.getBoundingClientRect()), at?.side, at?.back === f])
          if (at) close = at.onClose
        },
        closed,
      ),
    )
    expect(got).toEqual([['k1', [110, 70, 30, 12], 'aside', true]])
    close(true)
    expect(closed.mock.calls).toEqual([[true]])
  })

  test("with no rect, or one that is not, it stands inside the view's top-left corner, below that point", async () => {
    const f = frame()
    for (const anchor of [undefined, { left: 'x', top: 0, width: 1, height: 1 }, { left: 0, top: 0, width: -4, height: 1 }]) {
      let at: [number[], string] | null = null
      await runLabelCall('edit', { id: 'k1', anchor }, ctx(f, (_, a) => (at = [box(a!.anchor.getBoundingClientRect()), a!.side])))
      expect(at).toEqual([[108, 54, 0, 0], 'below'])
    }
    let side = ''
    await runLabelCall('edit', { id: null, anchor: { left: 0, top: 0, width: 80, height: 20 }, side: 'below' }, ctx(f, (_, a) => (side = a!.side)))
    expect(side).toBe('below')
  })

  test('the anchor follows the frame when it moves', () => {
    const f = frame()
    const a = frameAnchor(f, frameRect({ left: 5, top: 6, width: 7, height: 8 }))
    expect(box(a.getBoundingClientRect())).toEqual([105, 56, 7, 8])
    f.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400)
    expect(box(a.getBoundingClientRect())).toEqual([5, 6, 7, 8])
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
