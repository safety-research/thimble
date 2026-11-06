// @vitest-environment jsdom
// Asking about anything on the page (src/pointer/CmdPointer.tsx, PointerBox.tsx): a click with the ask key (⌘ on a
// Mac, Ctrl elsewhere, as jsdom is) on something that carries an anchor opens the ask box about it, and the question
// typed there starts a side thread about that place, which the chat opens.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { CmdPointer } from '../../src/pointer/CmdPointer.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

test('a click with the ask key on a card opens the ask box, and its question starts a side thread about the card', async () => {
  const made: Parameters<typeof api.createThread>[1][] = []
  vi.spyOn(api, 'createThread').mockImplementation(async (_ws, body) => {
    made.push(body)
    return { id: 't9' } as ChatMeta
  })
  const opened: string[] = []
  const off = bus.on('openChat', ({ chatId }) => void opened.push(chatId))
  // a card on the canvas, as the board draws it
  const board = document.body.appendChild(document.createElement('section'))
  board.setAttribute('data-panel', 'canvas')
  board.innerHTML = '<div data-anchor="card:a1"><p>Agent 3 ran 31 of the 40 runs.</p></div>'
  await mount(<CmdPointer ws="w" />)
  const words = board.querySelector('p')!
  await act(async () => {
    for (const type of ['mousedown', 'mouseup', 'click']) words.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ctrlKey: true }))
  })
  await settle()
  const field = document.querySelector<HTMLTextAreaElement>('.pointer-box textarea')!
  expect(field).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Why so many?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await settle()
  off()
  expect(made).toHaveLength(1)
  expect(made[0]).toMatchObject({ anchor: 'card:a1', text: 'Why so many?' })
  expect(opened).toEqual(['t9'])
  expect(document.querySelector('.pointer-box')).toBeNull()
})
