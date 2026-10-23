// @vitest-environment jsdom
// A message sent from main's composer shows at the list's end (src/chat/ChatPanel.tsx, send): the list follows the
// newest record while it is near its end, and a send takes it there also when the analyst had scrolled up to read an
// earlier answer, so their message and the turn it starts are in view.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
let posted: string[] = []

beforeEach(() => {
  posted = []
  const main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: false, attached: ATTACHED, module: true } as unknown as ChatMeta
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method && init.method !== 'GET' && !u.includes('/telemetry')) posted.push(`${init.method} ${u}`)
    const body = u.endsWith('/chats/main')
      ? { meta: main, events: [{ type: 'user', text: 'Count the runs per agent.', by: 'browser' }, { type: 'assistant', text: 'Agent 3 ran the most.' }] }
      : /\/chats(\?|$)/.test(u)
        ? [main]
        : /\/(proposals|notices|views)(\?|$)/.test(u)
          ? []
          : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** The list given a layout jsdom lacks: 2000 px of records in 500 px, scrolled to `top`. */
function layout(list: HTMLElement, top: number) {
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 })
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 500 })
  Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: top })
}

test('a send from a list scrolled up to read takes the list to its end', async () => {
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  const list = el.querySelector<HTMLElement>('.chat-list')!
  // the analyst scrolled up to the first answer: the list stops following its end
  layout(list, 0)
  await act(async () => list.dispatchEvent(new Event('scroll')))
  const box = el.querySelector<HTMLTextAreaElement>('.chat-composer textarea')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(box, 'And which agent ran the fewest?')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => el.querySelector<HTMLButtonElement>('.chat-composer button.composer-send')!.click())
  await settle()
  expect(posted.some((p) => p.startsWith('POST /api/ws/mini/'))).toBe(true)
  expect(list.scrollTop).toBe(2000)
})
