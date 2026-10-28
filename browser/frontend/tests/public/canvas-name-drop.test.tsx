// @vitest-environment jsdom
// A card dropped on a frame's name in a title row goes to that frame (src/canvas/Canvas.tsx nameAt): the frames of a
// path share one box, where a drop goes to the innermost frame, so a frame around it takes a card by its name in the
// shared title row.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { Canvas } from '../../src/canvas/Canvas.tsx'
import type { CanvasResponse, Cell, Group } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const cell = (id: string, notebook: string): Cell =>
  ({ id, kind: 'note', title: `Card ${id}`, notebook, created_by: 'user', ts: '2026-10-22T10:00:00Z', outputs: [], status: 'idle', payload: { text: 'x' }, text: 'x', height: 300 }) as unknown as Cell

// Analysis holds Spike, which holds Detail, which holds the card s: one box under the title row `Analysis / Spike /
// Detail`; Notes holds the card x, which is dragged
const DATA: CanvasResponse = {
  groups: [group('Analysis', { kind: 'split' }), group('Spike', { kind: 'split', parent: 'Analysis' }), group('Detail', { parent: 'Spike' }), group('Notes')],
  cells: [cell('s', 'Detail'), cell('x', 'Notes')],
}

let moves: { cells: string[]; group: string | null }[]
let under: Element[]

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('thimble:ws:canvas-view', JSON.stringify({ x: 0, y: 0, scale: 1 }))
  moves = []
  under = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/cells/move')) moves.push(JSON.parse(String(init?.body)))
    const body = u.endsWith('/canvas') ? DATA : u.includes('/chats') || u.endsWith('/cells/move') ? [] : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  // jsdom lays nothing out: what the browser finds under the pointer, through the card being dragged
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => under })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint
})

/** x dragged from its place to the client point (cx, cy), over `over`, and dropped there; the drag's tag while over it. */
async function dragX(el: HTMLElement, cx: number, cy: number, over: Element[]): Promise<string | null> {
  const card = el.querySelector('[data-cell="x"]')!.closest<HTMLElement>('.bcell')!
  await act(async () => void card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 500 })))
  under = [card, ...over]
  await act(async () => void window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy })))
  const tag = el.querySelector('.board-tag')?.textContent ?? null
  await act(async () => void window.dispatchEvent(new MouseEvent('mouseup', { clientX: cx, clientY: cy })))
  await settle()
  return tag
}

test("a card dropped on an outer frame's name in a path's title row goes to that frame", async () => {
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  const step = el.querySelector<HTMLElement>('.frame-step[data-step="Analysis"]')!
  expect(step).toBeTruthy()
  const name = step.querySelector('.frame-name')!
  // the title row stands above the box (Analysis at the top left of the board): the pointer on Analysis's name
  const tag = await dragX(el, 60, 45, [name, step, step.closest('.frame-title')!, step.closest('.frame')!])
  expect(tag).toBe('Move to Analysis')
  expect(moves).toEqual([{ cells: ['x'], group: 'Analysis' }])
})

test("and on the middle frame's name, to the middle frame", async () => {
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  const step = el.querySelector<HTMLElement>('.frame-step[data-step="Spike"]')!
  await dragX(el, 120, 45, [step.querySelector('.frame-name')!, step, step.closest('.frame-title')!, step.closest('.frame')!])
  expect(moves).toEqual([{ cells: ['x'], group: 'Spike' }])
})
