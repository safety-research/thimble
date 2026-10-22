// @vitest-environment jsdom
// Following Claude's cards (src/lib/follow.ts): a card Claude makes during a turn shows the canvas and the card, unless
// the person is busy; frames are open by default, and a frame the person collapsed stays collapsed while Claude writes
// into it (src/canvas/Canvas.tsx).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Canvas } from '../../src/canvas/Canvas.tsx'
import { dispatch } from '../../src/lib/events.ts'
import { busy, cardClaudeMade, FOLLOW_QUIET_MS, mayFollow, setLastInput, showsCanvas } from '../../src/lib/follow.ts'
import { show, single } from '../../src/shell/panes.ts'
import type { CanvasResponse, Cell, Group } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'
import { act } from 'react'

/** the canvas re-reads its board a moment after a card record (REFETCH_DEBOUNCE_MS) */
const reread = () => act(async () => void (await new Promise((r) => setTimeout(r, 400))))

describe('which cards the page follows', () => {
  test('a card Claude made (main, a thread, the terminal) is followed; one the person made, an edit and an old record are not', () => {
    for (const by of ['main', 'chat:th1', 'terminal']) expect(cardClaudeMade({ type: 'cell', op: 'created', cell: 'c1', by }), by).toBe('c1')
    for (const by of ['user', 'analyst']) expect(cardClaudeMade({ type: 'cell', op: 'created', cell: 'c1', by }), by).toBeNull()
    expect(cardClaudeMade({ type: 'cell', op: 'edited', cell: 'c1', by: 'main' })).toBeNull()
    expect(cardClaudeMade({ type: 'cell', op: 'created', cell: 'c1' })).toBeNull()
    expect(cardClaudeMade({ type: 'view', op: 'created', cell: 'c1', by: 'main' })).toBeNull()
  })

  test('the person is busy for a few seconds after a press, a key or the wheel, and while a field outside the chat has the focus', () => {
    expect(busy(10_000, 10_000 - FOLLOW_QUIET_MS + 1, null)).toBe(true)
    expect(busy(10_000, 10_000 - FOLLOW_QUIET_MS, null)).toBe(false)
    const chat = document.createElement('div')
    chat.className = 'chat'
    chat.dataset.panel = 'chat'
    const composer = document.createElement('textarea')
    chat.append(composer)
    const report = document.createElement('textarea')
    const box = document.createElement('input')
    box.type = 'checkbox'
    document.body.append(chat, report, box)
    // the composer keeps the focus after a message is sent; the report's editor is where the person writes
    expect(busy(60_000, 0, composer)).toBe(false)
    expect(busy(60_000, 0, report)).toBe(true)
    expect(busy(60_000, 0, box)).toBe(false)
    document.body.innerHTML = ''
  })

  test('a key just pressed holds the page still; after the quiet time it may follow', () => {
    setLastInput(performance.now())
    expect(mayFollow()).toBe(false)
    setLastInput(performance.now() - FOLLOW_QUIET_MS - 1)
    expect(mayFollow()).toBe(true)
    setLastInput()
  })

  test('a card Claude made shows the canvas in the focused pane, unless a pane shows it already or the person is busy', () => {
    const made = { type: 'cell', op: 'created', cell: 'c1', by: 'main' }
    setLastInput(performance.now() - FOLLOW_QUIET_MS - 1)
    expect(showsCanvas(made, ['files'])).toBe(true)
    expect(show(single('files'), 'canvas').root).toMatchObject({ kind: 'pane', surface: 'canvas' })
    expect(showsCanvas(made, ['files', 'canvas'])).toBe(false)
    expect(showsCanvas({ ...made, by: 'user' }, ['files'])).toBe(false)
    setLastInput(performance.now())
    expect(showsCanvas(made, ['report'])).toBe(false)
    setLastInput()
  })
})

const group = (id: string, title: string): Group => ({ id, title, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' })
const cell = (id: string, notebook: string, created_by = 'main'): Cell =>
  ({ id, kind: 'note', title: `Card ${id}`, notebook, created_by, ts: '2026-10-22T10:00:00Z', outputs: [], status: 'idle', payload: { text: 'x' }, text: 'x' }) as unknown as Cell

describe('a deck Claude writes', () => {
  let data: CanvasResponse
  beforeEach(() => {
    localStorage.clear()
    data = { groups: [group('g1', 'Deploys'), group('g2', 'Other')], cells: [cell('a', 'g1'), cell('b', 'g2', 'user')] }
    vi.stubGlobal('fetch', async (url: string) => {
      const body = String(url).endsWith('/canvas') ? data : String(url).includes('/chats') ? [] : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(() => {
    unmountAll()
    vi.unstubAllGlobals()
  })
  const isOpen = (g: string) => document.querySelector(`[data-group="${g}"] > .frame-title .frame-chev.is-open`) != null
  const shut = () => JSON.parse(localStorage.getItem('thimble:ws:canvas-shut') ?? '[]') as string[]

  test('every frame is open by default and stays open while Claude writes into it', async () => {
    await mount(<Canvas ws="ws" active={false} />)
    await settle()
    expect([isOpen('g1'), isOpen('g2')]).toEqual([true, true])
    data = { ...data, cells: [...data.cells, cell('c', 'g1'), cell('d', 'g2')] }
    dispatch({ type: 'cell', op: 'created', cell: 'c', by: 'main', notebook: 'g1' })
    dispatch({ type: 'cell', op: 'created', cell: 'd', by: 'main', notebook: 'g2' })
    await reread()
    await settle()
    expect([isOpen('g1'), isOpen('g2')]).toEqual([true, true])
    expect(shut()).toEqual([])
  })

  test('a frame the person collapsed stays collapsed while Claude writes into it', async () => {
    localStorage.setItem('thimble:ws:canvas-shut', JSON.stringify(['g1']))
    await mount(<Canvas ws="ws" active={false} />)
    await settle()
    expect([isOpen('g1'), isOpen('g2')]).toEqual([false, true])
    data = { ...data, cells: [...data.cells, cell('c', 'g1')] }
    dispatch({ type: 'cell', op: 'created', cell: 'c', by: 'main', notebook: 'g1' })
    await reread()
    await settle()
    expect([isOpen('g1'), isOpen('g2')]).toEqual([false, true])
    expect(shut()).toEqual(['g1'])
  })
})
