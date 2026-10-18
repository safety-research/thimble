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
import { FigureBlock, followedCaption } from '../../src/report/FigureBlock.tsx'
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
})

describe('followedCaption', () => {
  const was = { title: 'Q', takeaway: 'Most runs [[end early|card:c1]].' }
  test('follows a caption that says the old takeaway without its citations', () => {
    expect(followedCaption('Most runs end early.', was, { title: 'Q', takeaway: 'Few runs end early.' })).toBe('Few runs end early.')
  })
  test('keeps an edited caption, and waits while the card has no takeaway', () => {
    expect(followedCaption('Mine.', was, { title: 'Q', takeaway: 'Few runs end early.' })).toBeNull()
    expect(followedCaption('Most runs end early.', was, { title: 'Q', takeaway: '' })).toBeNull()
  })
})
