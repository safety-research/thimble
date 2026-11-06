// @vitest-environment jsdom
// The page's own command in the chat's composer (src/chat/commands.ts pageCommand, ChatPanel's send): /tour, alone in
// the message, runs the tour from its first step (src/shell/TourHost.tsx) and goes to no session.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-11-05T10:00:00+00:00'

describe("in the chat's composer", () => {
  let posted: { url: string; body: unknown }[]

  beforeEach(() => {
    posted = []
    localStorage.clear()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    Element.prototype.scrollIntoView = () => undefined  // jsdom lays nothing out
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (init?.method && init.method !== 'GET' && !u.includes('/telemetry')) posted.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : null })
      const main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: false, attached: { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }, module: true } as unknown as ChatMeta
      let body: unknown = {}
      // a way to reach Claude is chosen, so the step does not open by itself
      if (u.endsWith('/claude-access')) body = { how: 'api-key', describe: 'an API key, the one saved in the workbench', problem: null, key_saved: true, wif_file: '' }
      else if (u.endsWith('/chats/main')) body = { meta: main, events: [] }
      else if (/\/chats(\?|$)/.test(u)) body = [main]
      else if (/\/(proposals|notices|views)(\?|$)/.test(u)) body = []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(() => {
    unmountAll()
    vi.unstubAllGlobals()
  })

  const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.chat-composer textarea')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  /** `text` typed in main's composer and sent */
  const send = async (el: HTMLElement, text: string) => {
    await act(async () => {
      setValue.call(box(el), text)
      box(el).dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-composer button.composer-send')!.click())
    await settle()
  }

  test('/tour runs the tour, and goes to no session', async () => {
    const heard = vi.fn()
    const off = bus.on('tour', heard)
    try {
      const el = await mount(<ChatPanel ws="mini" />)
      await settle()
      await send(el, '/tour')
      expect(heard).toHaveBeenCalledTimes(1)
      expect(posted).toEqual([])
      expect(box(el).value).toBe('')
    } finally {
      off()
    }
  })
})
