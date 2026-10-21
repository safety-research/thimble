// @vitest-environment jsdom
// The busy line above the chat's input box (chat/ChatBusy): a spinner and "working" while the chat list says main's
// turn runs, gone once a `chat` event brings the list that says it ended; thimble's own job joins the same line. All
// names here are made up.
import { afterEach, expect, test, vi } from 'vitest'
import { ChatBusy } from '../../src/chat/ChatBusy.tsx'
import { bus } from '../../src/lib/bus.ts'
import { busyRecord } from '../../src/lib/busy.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('the busy line shows that main works while its turn runs, then thimble\'s own job on the same line, and not after', async () => {
  let running = true
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ id: 'main', kind: 'main', running }, { id: 't1', kind: 'thread', running: true }]), { status: 200, headers: { 'content-type': 'application/json' } }))
  const el = await mount(<ChatBusy ws="made-up" />)
  await settle()
  expect(el.querySelectorAll('.chat-busy').length).toBe(1)
  expect(el.querySelector('[data-busy="main"]')?.textContent).toBe('working')
  busyRecord('j1', 'labeling', true)
  await new Promise((r) => setTimeout(r, 600))
  await settle()
  expect(el.querySelector('[data-busy="labeling"]')?.textContent).toBe('working · labeling')
  busyRecord('j1', 'labeling', false)
  running = false
  bus.emit('chat', { chat: 'main' } as never)
  await new Promise((r) => setTimeout(r, 200))
  await settle()
  expect(el.querySelector('.chat-busy')).toBeNull()
})
