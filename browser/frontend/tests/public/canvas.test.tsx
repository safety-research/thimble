// @vitest-environment jsdom
// The canvas (src/canvas/Canvas.tsx, layout.ts), over a stand-in server that answers its routes: a card Claude draws
// shows its question and that it runs while the card check holds it, then its content and takeaway in the same place;
// Card in the bar makes a loose card where the analyst is looking, clear of what is drawn; and a card dropped on others
// moves down to the first place where it covers none.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from '../../src/canvas/Canvas.tsx'
import { boardOf, CARD_W, GAP, HEAD, layoutBoard, moveLocal, overlaps, PAD, placeFree, ROOT_Y, toPlane, UNMEASURED_H, type Rect, type View } from '../../src/canvas/layout.ts'
import { api } from '../../src/lib/api.ts'
import { dispatch } from '../../src/lib/events.ts'
import type { CanvasResponse, Cell, Group, Pos } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const note = (id: string, notebook: string, extra: Partial<Cell> = {}): Cell =>
  ({ id, kind: 'note', title: `Card ${id}`, notebook, created_by: 'user', ts: '2026-10-22T10:00:00Z', outputs: [], status: 'idle', payload: { text: 'x' }, text: 'x', pos: null, ...extra }) as unknown as Cell

/** What GET /canvas answers, and each request that changes state. */
let data: CanvasResponse
let posts: { url: string; body: Record<string, unknown> }[]
const VIEW: View = { x: 0, y: 0, scale: 0.8 }

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('thimble:ws:canvas-view', JSON.stringify(VIEW))
  posts = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (init?.method === 'POST' && !u.includes('/telemetry')) {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      posts.push({ url: u, body })
      if (u.endsWith('/cells')) {
        const made = note('n', 'l1', { pos: (body.pos as Pos) ?? null, kind: 'code', title: String(body.title) } as Partial<Cell>)
        data = { ...data, cells: [...data.cells, made] }
        return json(made)
      }
    }
    return json(u.endsWith('/canvas') ? data : u.includes('/chats') ? [] : {})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** Each card drawn: its box's place on the board and the words it shows. */
const drawn = (el: HTMLElement) =>
  Object.fromEntries(
    [...el.querySelectorAll<HTMLElement>('.bcell')].map((b) => [b.querySelector('[data-cell]')!.getAttribute('data-cell')!, { at: [b.style.left, b.style.top], text: b.textContent ?? '', running: !!b.querySelector('.bcell-run') }]),
  )

test('a card Claude draws shows its question while the card check holds it, then its content and takeaway in the same place', async () => {
  const card = (extra: Partial<Cell>) => note('c1', 'l1', { created_by: 'terminal', title: 'Which runs failed?', payload: { text: 'Every one of the 56 runs, one per line.' }, takeaway: '14 of the 56 runs failed.', ...extra } as Partial<Cell>)
  data = { groups: [group('l1', { kind: 'loose' })], cells: [note('a', 'l1'), card({ held: { since: '2026-10-22T10:00:01Z' } } as Partial<Cell>)] }
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  const held = drawn(el).c1
  expect(held.text).toContain('Which runs failed?')
  expect(held.running).toBe(true)
  expect(held.text).not.toContain('Every one of the 56 runs')
  expect(held.text).not.toContain('14 of the 56 runs failed.')

  // the check is done with it: the stream says the card changed, and the board reads it again
  data = { ...data, cells: [data.cells[0], card({ held: null } as Partial<Cell>)] }
  await act(async () => dispatch({ type: 'cell', notebook: 'l1', cell: 'c1', kind: 'edited' } as never))
  await act(async () => new Promise((r) => setTimeout(r, 400)))
  const shown = drawn(el).c1
  expect(shown.running).toBe(false)
  expect(shown.text).toContain('Every one of the 56 runs')
  expect(shown.text).toContain('14 of the 56 runs failed.')
  expect(shown.at).toEqual(held.at)
})

test("a key pressed on a control in another part of the page, such as a button in the chat, is that control's, not the board's", async () => {
  data = { groups: [group('g1', { title: 'Deploys' })], cells: [note('a', 'g1'), note('b', 'g1')] }
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  // a card selected on the board, and a button in the chat
  const face = el.querySelector<HTMLElement>('[data-cell="a"]')!
  await act(async () => {
    face.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  })
  const chat = document.body.appendChild(document.createElement('div'))
  chat.setAttribute('data-panel', 'chat')
  const button = chat.appendChild(document.createElement('button'))
  const press = (target: EventTarget, key: string) => {
    const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => void target.dispatchEvent(down))
    act(() => void target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })))
    return down.defaultPrevented
  }
  const deleted = vi.spyOn(api, 'deleteCell').mockResolvedValue({ ok: true })
  expect(press(button, ' '), 'Space presses the button, not the board').toBe(false)
  expect(press(button, 'Enter'), 'Enter presses the button, not the board').toBe(false)
  expect(press(button, 'Delete'), 'Delete deletes no card').toBe(false)
  await settle()
  expect(el.querySelector('.bfocus')).toBeNull()
  expect(deleted).not.toHaveBeenCalled()
  deleted.mockRestore()
  // the same keys with the focus on no control are the board's: Space pans, Enter opens the selected card in focus mode
  expect(press(document.body, ' ')).toBe(true)
  expect(press(document.body, 'Enter')).toBe(true)
  await settle()
  expect(el.querySelector('.bfocus')).not.toBeNull()
})

test('Card makes a loose card where the analyst is looking, clear of what is drawn, and no group', async () => {
  data = { groups: [group('g1', { title: 'Deploys' }), group('l1', { title: 'Loose cards', kind: 'loose' })], cells: [note('a', 'g1'), note('b', 'l1', { pos: { x: 900, y: 60 } })] }
  const before = layoutBoard(boardOf(data), new Set(['g1']), {})
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  const button = [...el.querySelectorAll<HTMLButtonElement>('.bctl-top button')].find((b) => b.textContent?.trim() === 'Card')!
  await act(async () => button.click())
  await settle()
  expect(posts.map((p) => p.url.replace(/^.*\/ws\/ws/, ''))).toEqual(['/cells'])
  const pos = posts[0].body.pos as Pos
  // in the viewport (the canvas takes 900 × 700 before it is measured), clear of the frame, its card and the loose card
  const at = toPlane(VIEW, 0, 0)
  expect(pos.x).toBeGreaterThanOrEqual(at.x)
  expect(pos.y).toBeGreaterThanOrEqual(at.y)
  for (const r of before.rects.values()) expect(overlaps({ x: pos.x, y: pos.y, w: CARD_W, h: UNMEASURED_H }, r)).toBe(false)
})

test('a card dropped on another moves straight down past every card it would cover', () => {
  // a frame of three cards, each 200 px tall, and a loose card far off, which the analyst drops over the second
  const H = 200
  const heights = { a: H, b: H, c: H, x: H }
  const open = new Set(['g'])
  const board: CanvasResponse = { groups: [group('g'), group('loose', { kind: 'loose' })], cells: [note('a', 'g'), note('b', 'g'), note('c', 'g'), note('x', 'loose', { pos: { x: 3000, y: 3000 } })] }
  const top = (i: number) => ROOT_Y + HEAD + i * (H + GAP)
  // just below b it would cover c, so it goes below c
  const pos = placeFree(board, 'x', 'g', { x: PAD + 100, y: top(1) + 50 - ROOT_Y }, open, heights)
  expect(pos).toEqual({ x: PAD + 100, y: top(2) + H + GAP - ROOT_Y })
  const rects = layoutBoard(boardOf(moveLocal(board, ['x'], 'g', undefined, pos)), open, heights).rects
  for (const other of ['a', 'b', 'c']) expect(overlaps(rects.get('x') as Rect, rects.get(other) as Rect), other).toBe(false)
})
