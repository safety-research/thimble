// @vitest-environment jsdom
// A demo page (src/lib/demo.ts): a pre-cache's or a worked example's workspace read without a Claude Code session, while
// none has attached to it. The top bar's Demo tag says so, with its tooltip, and the line right under the top bar says
// first that it is example data, not the analyst's files, and how to open their own folder. The chat's composer is
// disabled, so nothing can be typed, and hovering it shows exactly "This is a demo and thimble isn't connected to a
// live Claude Code session." The same note shows in the chat for every other action that needs Claude (Ask about this, a
// card's ask, a report's request, an agent's start), which each ask demoStop() first, and keeps what was typed. No view
// proposal card shows there, and the tour says it is a demo and that the chat takes no typing. The tour's welcome,
// which dims the line, says it first; elsewhere the welcome says that the tour uses example data.
import { act } from 'react'
import { TIP_DELAY_MS } from '../../src/components/Tooltip.tsx'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { ViewsBar } from '../../src/files/ViewsBar.tsx'
import { isDemoPage, setDemo } from '../../src/lib/demo.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-06T00:00:00+00:00'
const MAIN = { id: 'main', kind: 'main', role: 'main', title: '', created_at: T, parent: null } as unknown as ChatMeta

let posted: string[] = []
beforeEach(() => {
  posted = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method && init.method !== 'GET') posted.push(`${init.method} ${u}`)
    const body = u.endsWith('/chats/main') ? { meta: MAIN, events: [] } : /\/(chats|proposals|notices|views)(\?|$)/.test(u) ? [] : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  setDemo(false)
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('the signal', () => {
  test('a readable workspace is a demo page until a session attaches, and stays none once one ended', () => {
    expect(isDemoPage(MAIN, true)).toBe(true)
    expect(isDemoPage(MAIN, false)).toBe(false) // a folder of the analyst's own: the disconnected card instead
    expect(isDemoPage(null, true)).toBe(false) // main's meta not read yet
    expect(isDemoPage({ ...MAIN, attached: { session: 's' } } as unknown as ChatMeta, true)).toBe(false)
    expect(isDemoPage({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, true)).toBe(false)
  })
})

describe('what the page shows', () => {

  test('the composer is disabled, so nothing can be typed, and hovering it shows exactly the note', async () => {
    setDemo(true)
    const el = await mount(<ChatPanel ws="demo-collusion-wiki" />)
    await settle()
    await settle()
    const field = el.querySelector('.chat-composer textarea') as HTMLTextAreaElement
    expect(field).not.toBeNull()
    expect(field.disabled).toBe(true)
    expect(el.querySelector<HTMLButtonElement>('.chat-composer .composer-send')?.disabled).toBe(true)
    expect(el.querySelector('[data-precached-bar]')).toBeNull()
    expect(document.querySelector('.tip')).toBeNull()
    const form = el.querySelector('.chat-composer') as HTMLElement
    await act(async () => {
      form.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((r) => setTimeout(r, TIP_DELAY_MS + 50))
    })
    expect(document.querySelector('.tip')?.textContent).toBe("This is a demo and thimble isn't connected to a live Claude Code session.")
    expect(posted.filter((p) => p.includes('/events') || p.includes('/chats'))).toEqual([])
    expect(el.querySelector('.chat-offer')).toBeNull()
  })
})

describe('what the page leaves as it is (bug hunt F5)', () => {
  test("a view has no × and New view is off, with the note on hover; the analyst's own page keeps both", async () => {
    const bar = () => <ViewsBar ws="demo-made-up-wiki" value="browser" onChange={() => undefined} views={[{ slug: 'page-history', name: 'Page History' }]} />
    setDemo(true)
    let el = await mount(bar())
    await settle()
    expect(el.querySelector('[aria-label="Delete Page History"]')).toBeNull()
    const newView = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('New view')) as HTMLButtonElement
    expect(newView.disabled).toBe(true)
    await act(async () => {
      newView.closest('.demo-off')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((r) => setTimeout(r, TIP_DELAY_MS + 50))
    })
    expect(document.querySelector('.tip')?.textContent).toBe("This is a demo and thimble isn't connected to a live Claude Code session.")
    unmountAll()
    setDemo(false)
    el = await mount(bar())
    await settle()
    expect(el.querySelector('[aria-label="Delete Page History"]')).not.toBeNull()
    expect(([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('New view')) as HTMLButtonElement).disabled).toBe(false)
  })
})
