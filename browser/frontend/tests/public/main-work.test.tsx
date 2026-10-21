// @vitest-environment jsdom
// The top bar's sign of main's work (shell/TopBar MainWork): a spinner and "working" while the chat list says main's
// turn runs, gone once a `chat` event brings the list that says it ended. All names here are made up.
import { afterEach, expect, test, vi } from 'vitest'
import { MainWork } from '../../src/shell/TopBar.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('the top bar shows that main works while its turn runs, and not after', async () => {
  let running = true
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ id: 'main', kind: 'main', running }, { id: 't1', kind: 'thread', running: true }]), { status: 200, headers: { 'content-type': 'application/json' } }))
  const el = await mount(<MainWork ws="made-up" />)
  await settle()
  expect(el.querySelector('[data-busy="main"]')?.textContent).toBe('working')
  running = false
  bus.emit('chat', { chat: 'main' } as never)
  await new Promise((r) => setTimeout(r, 200))
  await settle()
  expect(el.querySelector('[data-busy="main"]')).toBeNull()
})
