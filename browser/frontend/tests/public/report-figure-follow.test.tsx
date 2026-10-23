// @vitest-environment jsdom
// A report figure follows its card (src/report/FigureBlock.tsx): when the card changes, the stream's `cell` record makes
// the figure read it again and draw it in place, and a caption that still says the card's old takeaway word for word
// takes the new one. A caption the analyst edited stays as they wrote it. In the editor the question line is a handle
// that moves the figure, with the drag the block actions in the gutter start.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api'
import { dispatch } from '../../src/lib/events'
import type { Cell } from '../../src/lib/types'
import { ReportContext, type ReportCtx } from '../../src/report/context'
import { FigureBlock} from '../../src/report/FigureBlock.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom lays nothing out: the figure draws its body only once it has a width
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 })
})

let card: Cell
const cellOf = (over: Partial<Cell>): Cell => ({
  id: 'c1',
  notebook: 'main',
  kind: 'code',
  title: 'How many runs end early?',
  takeaway: 'Most runs end early.',
  created_by: 'main',
  ts: '2026-10-15T10:00:00Z',
  status: 'ok',
  outputs: [{ 'text/plain': 'first chart' }],
  ...over,
})

beforeEach(() => {
  card = cellOf({})
  vi.spyOn(api, 'resolveRef').mockImplementation(async () => ({ kind: 'cell', record: { ...card } }) as never)
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

/** A figure block of card c1 with `caption`, in an editor whose updateBlock is recorded; `locked`, the figure as the
 * document last saved it is locked. */
async function figure(caption: string, ws = 'w-follow', { locked }: { locked?: boolean } = {}) {
  const editor = { updateBlock: vi.fn(), removeBlocks: vi.fn() }
  const block = { id: 'f1', props: { cell: 'card:c1', caption } }
  // the report's context is read from the URL when no editor provides it
  window.history.replaceState(null, '', `/?ws=${ws}`)
  const fig = <FigureBlock block={block} editor={editor as never} />
  const docRef = { current: { sections: [{ id: 's1', heading: 'Notes', paragraphs: [], figures: [{ id: 'f1', cell: 'card:c1', caption, locked }] }] } }
  const ctx = { ws, slug: 'report', docRef, submitPrompt: vi.fn(), submitCard: vi.fn() } as unknown as ReportCtx
  const el = await mount(locked === undefined ? fig : <ReportContext.Provider value={ctx}>{fig}</ReportContext.Provider>)
  await settle()
  return { el, editor }
}

/** Past the figure's wait after a change of its card. */
const waited = () => act(async () => void (await new Promise((r) => setTimeout(r, 350))))

/** The card changed on the canvas: the stream's record of it. */
async function changed(over: Partial<Cell>) {
  card = cellOf(over)
  await act(async () => dispatch({ type: 'cell', notebook: 'main', cell: 'c1', kind: 'edited' } as never))
  await waited()
  await settle()
}

describe('a report figure follows its card', () => {
  test('a new chart and takeaway redraw the figure in place, and an unedited caption follows', async () => {
    const { el, editor } = await figure('Most runs end early.', 'w-follow-1')
    const fig = el.querySelector('figure.wu-fig')!
    expect(fig.querySelector('.wu-fig-q')?.textContent).toBe('How many runs end early?')
    expect(fig.textContent).toContain('first chart')
    await changed({ outputs: [{ 'text/plain': 'second chart' }], takeaway: 'Two runs in three end early.' })
    expect(el.querySelector('figure.wu-fig')).toBe(fig)
    expect(fig.textContent).toContain('second chart')
    expect(fig.textContent).not.toContain('first chart')
    expect(editor.updateBlock).toHaveBeenCalledWith('f1', { props: { cell: 'card:c1', caption: 'Two runs in three end early.' } })
  })

  test('a caption the analyst edited keeps their words', async () => {
    const { el, editor } = await figure('Early ends cluster in one topic.', 'w-follow-2')
    await changed({ outputs: [{ 'text/plain': 'second chart' }], takeaway: 'Two runs in three end early.' })
    expect(el.textContent).toContain('second chart')
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })

  test('a locked figure redraws, and its caption stays as it is', async () => {
    const { el, editor } = await figure('Most runs end early.', 'w-follow-5', { locked: true })
    await changed({ outputs: [{ 'text/plain': 'second chart' }], takeaway: 'Two runs in three end early.' })
    expect(el.textContent).toContain('second chart')
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })

  test('while the card runs again the figure keeps its chart, and the takeaway the run clears changes no caption', async () => {
    const { el, editor } = await figure('Most runs end early.', 'w-follow-3')
    await changed({ status: 'running', takeaway: '', outputs: [] })
    expect(el.textContent).toContain('first chart')
    await changed({ status: 'ok', takeaway: '', outputs: [{ 'text/plain': 'second chart' }] })
    expect(el.textContent).toContain('second chart')
    expect(editor.updateBlock).not.toHaveBeenCalled()
    await changed({ status: 'ok', takeaway: 'Two runs in three end early.', outputs: [{ 'text/plain': 'second chart' }] })
    expect(editor.updateBlock).toHaveBeenCalledWith('f1', { props: { cell: 'card:c1', caption: 'Two runs in three end early.' } })
  })

  test("another card's change reads nothing again, and a burst of changes reads the card once", async () => {
    await figure('Most runs end early.', 'w-follow-4')
    const reads = vi.mocked(api.resolveRef).mock.calls.length
    await act(async () => dispatch({ type: 'cell', notebook: 'main', cell: 'c2', kind: 'edited' } as never))
    await waited()
    expect(vi.mocked(api.resolveRef).mock.calls.length).toBe(reads)
    // the history the stream replays as it opens
    await act(async () => {
      for (let k = 0; k < 20; k++) dispatch({ type: 'cell', notebook: 'main', cell: 'c1', kind: 'edited' } as never, true)
    })
    await waited()
    expect(vi.mocked(api.resolveRef).mock.calls.length).toBe(reads + 1)
  })
})

describe('a figure whose card changed while it was not on the page', () => {
  /** The card now, after an edit `e1` of its takeaway, and its version before that edit. */
  const edited = (before: Partial<Cell>) => {
    card = cellOf({ takeaway: 'Two runs in three end early.', edited: [{ id: 'e0', by: 'main', ts: '2026-10-15T10:00:00Z', fields: ['code'] }, { id: 'e1', by: 'main', ts: '2026-10-15T11:00:00Z', fields: ['takeaway'] }] })
    return vi.spyOn(api, 'cardVersion').mockImplementation(async (_ws, _id, entry) => ({ card: 'c1', before: entry, by: 'main', ts: '', fields: ['takeaway'], version: { ...cellOf({}), ...before } }) as never)
  }

  test('a caption that says an earlier takeaway takes the new one as the figure first reads the card', async () => {
    const versions = edited({ takeaway: 'Most runs [[end early|card:c1]].' })
    const { editor } = await figure('Most runs end early.', 'w-mount-1')
    await settle()
    expect(versions).toHaveBeenCalledWith('w-mount-1', 'c1', 'e1')
    expect(versions).not.toHaveBeenCalledWith('w-mount-1', 'c1', 'e0')
    expect(editor.updateBlock).toHaveBeenCalledWith('f1', { props: { cell: 'card:c1', caption: 'Two runs in three end early.' } })
  })

  test('a caption that says no earlier takeaway stays, and one that says the takeaway reads no version', async () => {
    const versions = edited({ takeaway: 'Most runs end early.' })
    const mine = await figure('Early ends cluster in one topic.', 'w-mount-3')
    await settle()
    expect(versions).toHaveBeenCalledTimes(1)
    expect(mine.editor.updateBlock).not.toHaveBeenCalled()
    unmountAll()
    versions.mockClear()
    const same = await figure('Two runs in three end early.', 'w-mount-4')
    await settle()
    expect(versions).not.toHaveBeenCalled()
    expect(same.editor.updateBlock).not.toHaveBeenCalled()
  })

})

describe("a figure's question line moves it", () => {
  /** An editor with BlockNote's side menu, whose drag calls are recorded. */
  const withSideMenu = () => {
    const sideMenu = { blockDragStart: vi.fn(), blockDragEnd: vi.fn() }
    const block = { id: 'f1', type: 'figure', props: { cell: 'card:c1', caption: '' } }
    const editor = { updateBlock: vi.fn(), removeBlocks: vi.fn(), getBlock: vi.fn(() => block), getExtension: vi.fn(() => sideMenu) }
    return { sideMenu, editor, block }
  }
  const dragEvent = (type: string) => {
    const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientY: number }
    e.dataTransfer = { setData: () => {}, clearData: () => {} }
    e.clientY = 0
    return e
  }

  test('a drag on the question line starts the drag the gutter starts, and its dragend ends it', async () => {
    const { sideMenu, editor, block } = withSideMenu()
    window.history.replaceState(null, '', '/?ws=w-drag-1')
    const el = await mount(<FigureBlock block={block} editor={editor as never} />)
    await settle()
    const q = el.querySelector<HTMLElement>('.wu-fig-q')!
    expect(q.getAttribute('draggable')).toBe('true')
    await act(async () => void q.dispatchEvent(dragEvent('dragstart')))
    expect(sideMenu.blockDragStart).toHaveBeenCalledTimes(1)
    expect(sideMenu.blockDragStart.mock.calls[0][1]).toBe(block)
    await act(async () => void q.dispatchEvent(dragEvent('dragend')))
    expect(sideMenu.blockDragEnd).toHaveBeenCalledTimes(1)
  })

})
