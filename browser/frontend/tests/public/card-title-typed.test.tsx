// @vitest-environment jsdom
// A question typed in place on a card (src/canvas/Cell.tsx): the card shows the typed words from the frame its editor
// closes, while the save goes out, never its old question (a new card's `New card`) until the board reloads.
import { act, useState } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { CellCard, type CardField } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const NEW: Cell = { id: 'c1', kind: 'code', title: 'New card', created_by: 'user', ts: '2026-10-15T10:00:00Z', code: '', outputs: [] } as unknown as Cell

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

test("a new card's typed question shows from the frame its editor closes, until the card comes back with it", async () => {
  let land: (r: Response) => void = () => undefined
  const saves: string[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (String(url).includes('/telemetry')) return Promise.resolve(new Response('{}', { status: 200 }))
    if ((init?.method ?? 'GET') !== 'GET') saves.push(String(init?.body))
    return new Promise<Response>((r) => (land = r))
  })
  const el = await mount(<Board />)
  const field = el.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'How many runs per agent?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  // the editor closed and the save is still out: the card reads the typed question, never `New card`
  expect(el.querySelector('textarea')).toBeNull()
  expect(el.querySelector('.bcell-q-text')?.textContent).toBe('How many runs per agent?')
  expect(saves).toEqual([JSON.stringify({ title: 'How many runs per agent?' })])
  land(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  await settle()
  expect(el.querySelector('.bcell-q-text')?.textContent).toBe('How many runs per agent?')
  // the card came back with its question: from then on it shows what the card says
  await act(async () => setCell({ ...NEW, title: 'How many runs per agent?' }))
  await act(async () => setCell({ ...NEW, title: 'Runs per agent' }))
  expect(el.querySelector('.bcell-q-text')?.textContent).toBe('Runs per agent')
})
