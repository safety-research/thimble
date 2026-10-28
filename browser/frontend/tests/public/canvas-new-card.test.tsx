// @vitest-environment jsdom
// Card in the bar at the top of the board (src/canvas/Canvas.tsx addCell): the canvas has no group by default, so the
// new card stands loose, outside every frame (`POST /cells`, the loose group), where the analyst is looking and clear of
// what is drawn there; no Your work frame is made for it.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { Canvas } from '../../src/canvas/Canvas.tsx'
import { boardOf, CARD_W, layoutBoard, overlaps, toPlane, UNMEASURED_H, type View } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, Group, Pos } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const group = (id: string, title: string): Group => ({ id, title, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' })
const cell = (id: string, notebook: string, pos: Pos | null = null): Cell =>
  ({ id, kind: 'note', title: `Card ${id}`, notebook, created_by: 'user', ts: '2026-10-22T10:00:00Z', outputs: [], status: 'idle', payload: { text: 'x' }, text: 'x', height: 300, pos }) as unknown as Cell

let data: CanvasResponse
let posts: { url: string; body: Record<string, unknown> }[]
const VIEW: View = { x: 0, y: 0, scale: 0.8 }

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('thimble:ws:canvas-view', JSON.stringify(VIEW))
  data = { groups: [group('g1', 'Deploys'), { ...group('l1', 'Loose cards'), kind: 'loose' }], cells: [cell('a', 'g1'), cell('b', 'l1', { x: 900, y: 60 })] }
  posts = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST' && !u.includes('/telemetry')) {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      posts.push({ url: u, body })
      if (u.endsWith('/cells')) {
        const made = { ...cell('n', 'l1', (body.pos as Pos) ?? null), kind: 'code', title: String(body.title), code: '' } as unknown as Cell
        data = { ...data, cells: [...data.cells, made] }
        return new Response(JSON.stringify(made), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    const body = u.endsWith('/canvas') ? data : u.includes('/chats') ? [] : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('Card makes a loose card in view, clear of what is drawn, and no group', async () => {
  const before = layoutBoard(boardOf(data), new Set(['g1']), {})
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  const button = [...el.querySelectorAll<HTMLButtonElement>('.bctl-top button')].find((b) => b.textContent?.trim() === 'Card')!
  await act(async () => button.click())
  await settle()
  expect(posts.map((p) => p.url.replace(/^.*\/ws\/ws/, ''))).toEqual(['/cells'])
  const pos = posts[0].body.pos as Pos
  expect(pos).toBeTruthy()
  // in the viewport (the canvas takes 900 × 700 before it is measured), clear of the frame, its card and the loose card
  const at = toPlane(VIEW, 0, 0)
  expect(pos.x).toBeGreaterThanOrEqual(at.x)
  expect(pos.y).toBeGreaterThanOrEqual(at.y)
  for (const r of before.rects.values()) expect(overlaps({ x: pos.x, y: pos.y, w: CARD_W, h: UNMEASURED_H }, r)).toBe(false)
})
