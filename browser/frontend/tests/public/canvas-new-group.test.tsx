// @vitest-environment jsdom
// Group in the bar at the top of the board with no card selected (src/canvas/Canvas.tsx addGroup): the new frame stands
// where the analyst is looking, clear of what is drawn there, and the view stays where it was.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { Canvas } from '../../src/canvas/Canvas.tsx'
import { boardOf, freeSpot, GAP, layoutBoard, MIN_FRAME_H, MIN_FRAME_W, overlaps, TITLE, toPlane, type View } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, Group, Pos } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const group = (id: string, title: string): Group => ({ id, title, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' })
const cell = (id: string, notebook: string): Cell =>
  ({ id, kind: 'note', title: `Card ${id}`, notebook, created_by: 'user', ts: '2026-10-22T10:00:00Z', outputs: [], status: 'idle', payload: { text: 'x' }, text: 'x', height: 300 }) as unknown as Cell

let data: CanvasResponse
let made: { title?: string; pos?: Pos | null }[]
const VIEW: View = { x: 0, y: 0, scale: 0.8 }

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('thimble:ws:canvas-view', JSON.stringify(VIEW))
  data = { groups: [group('g1', 'Deploys')], cells: [cell('a', 'g1'), cell('b', 'g1')] }
  made = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/notebooks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { title: string; pos?: Pos | null }
      made.push(body)
      const g = { ...group('g2', body.title), pos: body.pos ?? null }
      data = { ...data, groups: [...data.groups, g] }
      return new Response(JSON.stringify(g), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = u.endsWith('/canvas') ? data : u.includes('/chats') ? [] : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('Group with nothing selected makes the frame in view and leaves the view where it was', async () => {
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  const button = [...el.querySelectorAll<HTMLButtonElement>('.bctl-top button')].find((b) => b.textContent?.trim() === 'Group')!
  await act(async () => button.click())
  await settle()
  await act(async () => void (await new Promise((r) => setTimeout(r, 300))))
  expect(made).toHaveLength(1)
  const pos = made[0].pos
  expect(pos).toBeTruthy()
  // in the viewport (the canvas takes 900 × 700 before it is measured), clear of the frame and its cards
  const at = toPlane(VIEW, 0, 0)
  expect(pos!.x).toBeGreaterThanOrEqual(at.x)
  expect(pos!.y).toBeGreaterThanOrEqual(at.y)
  expect((pos!.x + MIN_FRAME_W) * VIEW.scale).toBeLessThanOrEqual(900)
  expect((pos!.y + MIN_FRAME_H) * VIEW.scale).toBeLessThanOrEqual(700)
  const before = layoutBoard(boardOf({ ...data, groups: data.groups.filter((g) => g.id === 'g1') }), new Set(['g1']), {})
  for (const r of before.rects.values()) expect(overlaps({ x: pos!.x, y: pos!.y - TITLE, w: MIN_FRAME_W, h: MIN_FRAME_H + TITLE }, r)).toBe(false)
  expect(JSON.parse(localStorage.getItem('thimble:ws:canvas-view') ?? 'null')).toEqual(VIEW)
})

test("the new frame's title row stands GAP clear of the frame above it, as its box does", () => {
  // a frame above whose box ends at 100, and room under it
  const above = { x: 0, y: 0, w: 1000, h: 100 }
  const pos = freeSpot({ x: 0, y: 0, w: 1000, h: 1000 }, MIN_FRAME_W, MIN_FRAME_H, [above])!
  expect(pos.y - TITLE - GAP).toBeGreaterThanOrEqual(above.y + above.h)
})
