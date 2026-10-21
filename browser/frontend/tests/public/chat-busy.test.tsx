// @vitest-environment jsdom
// The busy line above the chat's input box (chat/ChatBusy): "answering" while the chat list says main's turn runs and
// "answering: <thread>" for a thread's, the newest step first with "+1" for each other, gone once a `chat` event brings
// the list that says it ended. All names here are made up.
import { afterEach, expect, test, vi } from 'vitest'
import { answering, ChatBusy } from '../../src/chat/ChatBusy.tsx'
import { bus } from '../../src/lib/bus.ts'
import { busyRecord } from '../../src/lib/busy.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('each running chat is its own step, named by its thread', () => {
  expect(answering([{ id: 'main', kind: 'main', running: true }, { id: 't1', kind: 'thread', title: 'Why the spike on day three', running: true }, { id: 't2', kind: 'thread', running: false }])).toEqual([
    { id: 'chat:main', word: 'answering' },
    { id: 'chat:t1', word: 'answering: Why the spike on day th…' },
  ])
})

test('the busy line says main answers while its turn runs, then the newest step with +1, and nothing after', async () => {
  let running = true
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ id: 'main', kind: 'main', running }]), { status: 200, headers: { 'content-type': 'application/json' } }))
  const el = await mount(<ChatBusy ws="made-up" />)
  await settle()
  await new Promise((r) => setTimeout(r, 700))
  await settle()
  expect(el.querySelectorAll('.chat-busy').length).toBe(1)
  expect(el.querySelector('[data-busy="answering"]')?.textContent).toBe('answering')
  busyRecord('j1', 'labeling: tone', true)
  await new Promise((r) => setTimeout(r, 600))
  await settle()
  expect(el.querySelector('.chat-busy')?.textContent).toBe('labeling: tone +1')
  busyRecord('j1', 'labeling: tone', false)
  running = false
  bus.emit('chat', { chat: 'main' } as never)
  await new Promise((r) => setTimeout(r, 300))
  await settle()
  expect(el.querySelector('.chat-busy')).toBeNull()
})
