// @vitest-environment jsdom
// A demo page (src/lib/demo.ts): a pre-cache's or a worked example's workspace read without a Claude Code session, while
// none has attached to it. The top bar's Demo tag says so, with its tooltip and nothing else. The composer stays and
// takes typing; a send shows one calm note in the chat, keeps the typed text and reaches no server. The same note
// stands in for every other action that needs Claude (Ask about this, a card's ask, a report's request, an agent's
// start), which each ask demoStop() first. No view proposal card shows there, and the tour says it is a demo.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { DemoNote } from '../../src/chat/DemoNote.tsx'
import { DEMO_NOTE, DEMO_TAG, DEMO_TIP, demoStop, dismissDemoNote, isDemo, isDemoPage, onDemoNote, setDemo } from '../../src/lib/demo.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { DemoTag } from '../../src/shell/DemoTag.tsx'
import { sessionTexts, tourSteps } from '../../src/tour/steps.ts'
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
})

describe('the signal', () => {
  test('a readable workspace is a demo page until a session attaches, and stays none once one ended', () => {
    expect(isDemoPage(MAIN, true)).toBe(true)
    expect(isDemoPage(MAIN, false)).toBe(false) // a folder of the analyst's own: the disconnected card instead
    expect(isDemoPage(null, true)).toBe(false) // main's meta not read yet
    expect(isDemoPage({ ...MAIN, attached: { session: 's' } } as unknown as ChatMeta, true)).toBe(false)
    expect(isDemoPage({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, true)).toBe(false)
  })

  test('an action stops only on a demo page, and each stop asks for the note again', () => {
    const opened: number[] = []
    const off = onDemoNote(() => opened.push(1))
    expect(demoStop()).toBe(false)
    setDemo(true)
    expect(isDemo()).toBe(true)
    expect(demoStop()).toBe(true)
    expect(demoStop()).toBe(true)
    expect(opened.length).toBe(2)
    off()
    setDemo(false)
    expect(demoStop()).toBe(false)
  })
})

describe('what the page shows', () => {
  test('the Demo tag shows on a demo page only, with its tooltip and nothing else', async () => {
    const el = await mount(<DemoTag />)
    expect(el.textContent).toBe('')
    await act(async () => setDemo(true))
    const tag = el.querySelector('.shell-demo') as HTMLElement
    expect(tag.textContent).toBe(DEMO_TAG)
    expect(DEMO_TAG).toBe('Demo')
    expect(tag.getAttribute('aria-label')).toBe(`Demo: ${DEMO_TIP}`)
    expect(DEMO_TIP).toBe("Example data and a finished analysis; Claude isn't connected here")
    expect(tag.tabIndex).toBe(0)
  })

  test('the note shows once an action stopped, says where to go, and × hides it until the next', async () => {
    setDemo(true)
    const el = await mount(<DemoNote />)
    expect(el.querySelector('.chat-demo-note')).toBeNull()
    await act(async () => void demoStop())
    expect(el.querySelector('.chat-demo-note-text')?.textContent).toBe(DEMO_NOTE)
    expect(DEMO_NOTE).toBe("This is a demo, so Claude isn't connected here. To ask about your own files, run thimble in a folder of transcripts.")
    expect(el.querySelectorAll('.chat-demo-note').length).toBe(1)
    await act(async () => void demoStop())
    expect(el.querySelectorAll('.chat-demo-note').length).toBe(1) // one note, however many actions
    await act(async () => (el.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click())
    expect(el.querySelector('.chat-demo-note')).toBeNull()
    await act(async () => void demoStop())
    expect(el.querySelector('.chat-demo-note')).not.toBeNull()
    await act(async () => dismissDemoNote())
  })

  test('the composer stays and takes typing; a send shows the note, keeps the text and posts nothing', async () => {
    setDemo(true)
    const el = await mount(<ChatPanel ws="demo-collusion-wiki" />)
    await settle()
    await settle()
    const field = el.querySelector('.chat-composer textarea') as HTMLTextAreaElement
    expect(field).not.toBeNull()
    expect(el.querySelector('[data-precached-bar]')).toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(field, 'Which agents merged most?')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle()
    expect(el.querySelector('.chat-demo-note-text')?.textContent).toBe(DEMO_NOTE)
    expect((el.querySelector('.chat-composer textarea') as HTMLTextAreaElement).value).toBe('Which agents merged most?')
    expect(posted.filter((p) => p.includes('/events') || p.includes('/chats'))).toEqual([])
    expect(el.querySelector('.chat-offer')).toBeNull()
  })

  test("the tour's steps about the chat say it is a demo there, and stay as they were elsewhere", () => {
    const live = tourSteps('⌘', true, false)
    const demo = tourSteps('⌘', true, true)
    expect(live[0].title).toBe('Your Claude Code session')
    expect(live[0].body).toBe('This chat is your Claude Code session: ask it anything about the files.')
    expect(demo[0].title).toBe('The chat')
    expect(demo[0].body).toContain("This is a demo, so Claude isn't connected here.")
    expect(demo[1].body).not.toContain('where you started thimble.')
    expect(demo.some((s) => s.body === sessionTexts(true).ask)).toBe(true)
    expect(demo.length).toBe(live.length)
  })
})
