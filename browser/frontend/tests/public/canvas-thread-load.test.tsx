// @vitest-environment jsdom
// A side thread's card on a page that loads (src/canvas/Canvas.tsx, layout.ts boardOf): the canvas route names each
// thread's anchor with the cards, so the first time the board draws, the thread's card already stands beside the card
// the thread is about, and it stays there when the chats arrive; nothing in the column under it moves.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from '../../src/canvas/Canvas.tsx'
import { CARD_W, GAP } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, ChatMeta, Group } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const loose: Group = { id: 'l', title: 'Loose', parent: null, kind: 'loose', anchor: null, chat: null, role: 'analyst' }
const card = (id: string, by: string, ts: string): Cell =>
  ({ id, kind: 'note', title: `Card ${id}`, notebook: 'l', created_by: by, ts, created_ts: ts, outputs: [], status: 'idle', payload: { text: 'x' }, text: 'x', pos: null }) as unknown as Cell
const data: CanvasResponse = {
  groups: [loose],
  cells: [card('a', 'terminal', '2026-10-29T10:00:00Z'), card('b', 'terminal', '2026-10-29T10:01:00Z'), card('t1', 'chat:th', '2026-10-29T10:02:00Z')],
  threads: { th: 'card:a' },
}
const chats = [{ id: 'main', kind: 'main' }, { id: 'th', kind: 'thread', anchor: 'card:a', title: 'Which stage?' }] as unknown as ChatMeta[]
let answerChats: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    // the chats answer only when the test says so, after the board has drawn
    if (u.endsWith('/chats')) return new Promise<Response>((done) => (answerChats = () => done(json(chats))))
    return json(u.endsWith('/canvas') ? data : {})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  answerChats = null
})

/** Where each card is drawn on the plane: its box's left and top. */
const where = (el: HTMLElement): Record<string, [number, number]> =>
  Object.fromEntries(
    [...el.querySelectorAll<HTMLElement>('.bcell')].map((b) => [b.querySelector('[data-cell]')!.getAttribute('data-cell')!, [parseFloat(b.style.left), parseFloat(b.style.top)]]),
  )

test("the first draw puts a thread's card beside the card it is about, before the chats arrive, and it stays there", async () => {
  const el = await mount(<Canvas ws="ws" active={true} />)
  await settle()
  const first = where(el)
  expect(Object.keys(first).sort()).toEqual(['a', 'b', 't1'])
  expect(first.t1).toEqual([first.a[0] + CARD_W + GAP, first.a[1]])
  expect(first.b[0]).toBe(first.a[0])
  expect(answerChats).not.toBeNull()
  answerChats!()
  await settle()
  expect(where(el)).toEqual(first)
})
