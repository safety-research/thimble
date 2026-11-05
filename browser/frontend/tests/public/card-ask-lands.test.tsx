// @vitest-environment jsdom
// A request on a card (src/canvas/Cell.tsx): ⌘↵ in the question typed in place sends it to main, which reads it at its
// next step, and the card shows `sent to main` until main's work lands in it, an edit of the card by someone other than
// the analyst or the card the stream names for the request, not until main's whole turn ends.
import { act, useState } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { CellCard, type CardField } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { bus } from '../../src/lib/bus.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const ASKED = 'A plot of the failed runs over the last week'
const NEW: Cell = { id: 'c1', kind: 'code', title: 'New card', created_by: 'user', ts: '2026-11-05T10:00:00Z', code: '', outputs: [] } as unknown as Cell
let asks: Record<string, unknown>[]

beforeEach(() => {
  asks = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/events') && init?.method === 'POST') asks.push(JSON.parse(String(init.body)).payload)
    // main works all along: its chat says it runs
    const body = u.includes('/chats') ? [{ id: 'main', running: true }] : u.endsWith('/events') ? { id: 'e1', kind: 'card', delivered: 1 } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

let setCell: (c: Cell) => void = () => undefined
function Board() {
  const [cell, set] = useState(NEW)
  const [editing, setEditing] = useState<CardField | null>('title')
  setCell = set
  const noop = () => undefined
  return (
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: noop, openThread: noop }}>
      <CellCard
        cell={cell} x={0} y={0} w={420} h={null} selected alone collapsed={false} deck={false} dragging={false}
        detailOpen={false} editing={editing} z={1} register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop}
        onAction={noop} onEdit={(_, f) => setEditing(f)}
      />
    </CanvasContext.Provider>
  )
}

/** The card's request sent as the analyst sends it: the question typed in place, then ⌘↵. */
async function ask(): Promise<HTMLElement> {
  const el = await mount(<Board />)
  const field = el.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, ASKED)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.focus()
  })
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true })))
  await settle()
  await act(async () => setCell({ ...NEW, title: ASKED, edited: [{ by: 'user', ts: '2026-11-05T10:01:00Z', fields: ['title'] }] }))
  return el
}

const sent = (el: HTMLElement) => /sent to main/.test(el.querySelector('.bcell-run')?.textContent ?? '')
const edits = (...by: string[]) => by.map((b, i) => ({ by: b, ts: `2026-11-05T10:0${i + 1}:00Z`, fields: ['code'] }))

test("the card shows `sent to main` until main's edit of it lands, though main's turn goes on", async () => {
  const el = await ask()
  expect(asks.map((a) => [a.text, a.card])).toEqual([[ASKED, 'c1']])
  expect(sent(el)).toBe(true)
  await act(async () => setCell({ ...NEW, title: ASKED, code: 'chart(runs)', edited: edits('user', 'chat') }))
  expect(sent(el)).toBe(false)
})

test("an edit of the analyst's own keeps the card out with main", async () => {
  const el = await ask()
  await act(async () => setCell({ ...NEW, title: `${ASKED}, by day`, edited: edits('user', 'user') }))
  expect(sent(el)).toBe(true)
})

test('a card the stream names for the request ends the wait too', async () => {
  const el = await ask()
  const request = String(asks[0].group).replace(/^request:/, '')
  await act(async () => bus.emit('cardRequest', { request: 'another', card: 'c9' }))
  expect(sent(el)).toBe(true)
  await act(async () => bus.emit('cardRequest', { request, card: 'c2' }))
  expect(sent(el)).toBe(false)
})
