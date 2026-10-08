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
const { frameAnchor, frameRect, runLabelCall } = await import('../../src/files/labelCalls.ts')
const { useLabelRuns, useLabelSide } = await import('../../src/files/ViewSide.tsx')
const { scopeLine } = await import('../../src/files/LabelCard.tsx')
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
      // every field, since a new label needs them
      expect(shape(card).keys).toEqual(['Over', 'Marks', 'Applies to', 'Classifier', 'Model', 'Classes'])
      expect(card.querySelector('.label-card-more')).toBeNull()
    }
    expect(popover()!.getAttribute('aria-label')).toBe('New label')
  })
})

/** Type `text` into a field as React hears it. */
async function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('a compact card', () => {
  test('More holds the rest: what it labels and marks, what it applies to, the classifier, the model, the highlights and + class', async () => {
    const el = await mount(<SideCard editing="k1" />)
    const more = el.querySelector<HTMLButtonElement>('.label-card-more')!
    expect(more.textContent).toBe('More')
    await act(async () => more.click())
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const body = el.querySelector('.label-card-more-body')!
    expect([...body.querySelectorAll('.label-card-key')].map((e) => e.textContent)).toEqual(['Over', 'Marks', 'Applies to', 'Classifier', 'Model', 'Highlight'])
    expect([...body.querySelectorAll('.label-card-hlname')].map((e) => e.textContent)).toEqual(['reading', 'writing', 'other'])
    expect(body.querySelectorAll('[role="switch"]')).toHaveLength(3)
    expect([...body.querySelectorAll('button')].some((b) => b.textContent === 'class')).toBe(true)
    await act(async () => more.click())
    expect(el.querySelector('.label-card-more-body')).toBeNull()
  })

  test("More stays as the analyst left it for the next card the page opens", async () => {
    const first = await mount(<SideCard editing="k1" />)
    await act(async () => first.querySelector<HTMLButtonElement>('.label-card-more')!.click())
    unmountAll()
    const next = await mount(<SideCard editing="k1" />)
    expect(next.querySelector('.label-card-more-body')).not.toBeNull()
    await act(async () => next.querySelector<HTMLButtonElement>('.label-card-more')!.click())
  })

  test('a label of one color has its name in that color, in place of the swatch', async () => {
    const one = { ...kind, id: 'k2', classes: [{ name: 'asks', color: 3, highlight: true }, { name: 'other', color: 0, highlight: false }], labels: ['asks', 'other'] } as unknown as Concept
    const el = await mount(<SideCard editing="k2" of={{ ...labels, all: [one], on: [one], byId: new Map([[one.id, one]]) }} />)
    expect(el.querySelector<HTMLInputElement>('[aria-label="Name"]')!.style.color).toBe('var(--label-3)')
    expect(el.querySelector('.label-card-swatch, .label-card-tag')).toBeNull()
  })

  test('an edit shows Cancel and Re-run; put back, they go again', async () => {
    const el = await mount(<SideCard editing="k1" />)
    const prompt = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!
    await type(prompt, 'What the agent does.')
    expect(shape(el.querySelector('.label-card')!).foot).toEqual(['Cancel', 'Re-run'])
    await type(prompt, 'What the agent is doing in this message.')
    expect(shape(el.querySelector('.label-card')!).foot).toEqual([])
    await type(el.querySelector<HTMLInputElement>('[aria-label="Name"]')!, 'activity')
    expect(shape(el.querySelector('.label-card')!).foot).toEqual(['Cancel', 'Re-run'])
  })

  test("the scope says the files and how many records, as the label's row in the Labels pane does", () => {
    expect(scopeLine(kind)).toBe('transcript.jsonl · 1,815 records')
    expect(scopeLine({ ...kind, last_run: { status: 'done', ts: '2026-10-07T00:00:00Z', total: 2064, matches: 1815, failed: 230 } } as unknown as Concept)).toBe('transcript.jsonl · 1,815 of 2,064 records')
    expect(scopeLine({ ...kind, glob: 'a.jsonl, b/*.jsonl', n_labeled: undefined } as unknown as Concept)).toBe('a.jsonl, b/*.jsonl')
  })

  test('the prompt stands about four lines tall until it has the focus', async () => {
    const el = await mount(<SideCard editing="k1" />)
    const prompt = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!
    expect(prompt.style.maxHeight).toBe('90px')
    expect(el.querySelector('.label-card-body')!.classList.contains('is-clamped')).toBe(true)
    await act(async () => prompt.focus())
    expect(prompt.style.maxHeight).toBe('180px')
    expect(el.querySelector('.label-card-body')!.classList.contains('is-clamped')).toBe(false)
    await act(async () => prompt.blur())
    expect(prompt.style.maxHeight).toBe('90px')
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
    expect(picks.map((b) => b.getAttribute('aria-label'))).toEqual([...LABEL_WHEEL.flat().map((n) => `Color ${n}`), 'Grey'])
    expect(picks.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label'))).toEqual(['Color 2'])
    expect(palette()!.querySelector('.colorby-palette-head')?.textContent).toBe('writing')
    await act(async () => (picks.find((b) => b.getAttribute('aria-label') === 'Color 5') as HTMLButtonElement).click())
    expect(setColour.mock.calls).toEqual([['k1', 'writing', 5]])
    expect(palette()).toBeNull()
  })

  test("a class not saved yet takes the color in the draft, and a class that had it takes the old one", async () => {
    const setColour = labels.setColour as ReturnType<typeof vi.fn>
    setColour.mockClear()
    const el = await mount(<SideCard editing="new" />)
    const colours = () => [...el.querySelectorAll<HTMLElement>('.label-card-colour')].map((b) => b.style.getPropertyValue('--c'))
    const before = colours()
    await act(async () => swatch(el, 'no match').click())
    await act(async () => [...palette()!.querySelectorAll<HTMLButtonElement>('.colorby-pick')].find((b) => b.style.getPropertyValue('--c') === before[0])!.click())
    expect(colours()).toEqual([before[1], before[0]])
    expect(setColour).not.toHaveBeenCalled()
  })

  test('Escape in the palette closes the palette alone, in the popover too', async () => {
    await mount(<LabelEditorHost ws="w" />)
    await act(async () => openLabelEditor({ id: 'k1', anchor: control() }))
    await settle()
    const at = swatch(popover()!, 'reading')
    at.focus()
    await act(async () => at.click())
    // the palette takes the focus on the class's own color
    await act(frames)
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true')
    expect(palette()!.contains(document.activeElement)).toBe(true)
    await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(palette()).toBeNull()
    expect(popover(), 'the editor stays open').not.toBeNull()
    expect(document.activeElement, 'the focus back on the swatch').toBe(swatch(popover()!, 'reading'))
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

  test('× closes it, and so does Cancel once an edit shows it', async () => {
    await mount(<LabelEditorHost ws="w" />)
    const at = control()
    for (const name of ['Close', 'Cancel']) {
      const closed = vi.fn()
      await act(async () => openLabelEditor({ id: 'k1', anchor: at, back: at, onClose: closed }))
      await act(frames)
      if (name === 'Cancel') await type(popover()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!, 'What the agent does.')
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
