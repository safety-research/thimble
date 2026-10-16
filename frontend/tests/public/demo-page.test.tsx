// @vitest-environment jsdom
// A demo page (src/lib/demo.ts): a pre-cache's or a worked example's workspace read without a Claude Code session, while
// none has attached to it. The top bar's Demo tag says so, with its tooltip, and the line right under the top bar says
// first that it is example data, not the analyst's files, and how to open their own folder. The chat's composer is
// disabled, so nothing can be typed, and hovering it shows exactly "This is a demo and thimble isn't connected to a
// live Claude Code session." The same note shows in the chat for every other action that needs Claude (Ask about this, a
// card's ask, a report's request, an agent's start), which each ask demoStop() first, and keeps what was typed. No view
// proposal card shows there, and the tour says it is a demo and that the chat takes no typing. The tour's welcome,
// which dims the line, says it first.
import { act } from 'react'
import App from '../../src/App.tsx'
import { TIP_DELAY_MS } from '../../src/components/Tooltip.tsx'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { DemoNote } from '../../src/chat/DemoNote.tsx'
import { DEMO_LINE, DEMO_NOTE, DEMO_TAG, DEMO_TIP, demoStop, dismissDemoNote, isDemo, isDemoPage, onDemoNote, setDemo } from '../../src/lib/demo.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { DemoLine } from '../../src/shell/DemoLine.tsx'
import { DemoTag } from '../../src/shell/DemoTag.tsx'
import { runTour } from '../../src/tour/run.ts'
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

  test('the line under the top bar says first that this is example data, not your files, and how to open your own folder', async () => {
    const el = await mount(<DemoLine />)
    expect(el.querySelector('.shell-demo-line')).toBeNull()
    await act(async () => setDemo(true))
    const line = el.querySelector('.shell-demo-line') as HTMLElement
    expect(DEMO_LINE).toBe('This is example data, not your files. To open your own folder, run `thimble` in it.')
    expect(line.textContent).toBe('This is example data, not your files. To open your own folder, run thimble in it.')
    expect([...line.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['thimble'])
    await act(async () => setDemo(false))
    expect(el.querySelector('.shell-demo-line')).toBeNull()
  })

  test('a demo workspace shows the line right under the top bar, and goes without it once a session attached', async () => {
    const open = async (main: ChatMeta) => {
      unmountAll()
      vi.stubGlobal('fetch', async (url: string) => {
        const u = String(url)
        if (u === '/api/ui/key') return new Response(null, { status: 204 })
        const path = '/h/.thimble/examples/example-timeline'
        const body = u === '/api/workspaces' ? [{ name: 'example-timeline', kind: 'example', folder: 'example-timeline', path }]
          : u === '/api/corpora' ? [{ name: 'example-timeline', manifest: {}, path }]
          : u.endsWith('/chats') ? [main]
          : u.endsWith('/chats/main') ? { meta: main, events: [] }
          : /\/(chats|proposals|notices|views)(\?|$)/.test(u) ? [] : null
        return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
      })
      window.history.replaceState(null, '', '/?ws=example-timeline')
      const el = await mount(<App />)
      for (let i = 0; i < 4; i++) await settle()
      return el
    }
    let el = await open(MAIN)
    const bar = el.querySelector('.shell-topbar') as HTMLElement
    expect(bar.querySelector('.shell-demo')?.textContent).toBe('Demo') // the tag stays
    expect(bar.nextElementSibling?.className).toBe('shell-demo-line')
    expect(bar.nextElementSibling?.textContent).toBe(DEMO_LINE.replace(/`/g, ''))
    el = await open({ ...MAIN, attached: { session: 's' } } as unknown as ChatMeta)
    expect(el.querySelector('.shell-topbar')).not.toBeNull()
    expect(el.querySelector('.shell-demo-line')).toBeNull()
    expect(el.querySelector('.shell-demo')).toBeNull()
  })

  test('the note shows once an action stopped, says thimble is not connected, and × hides it until the next', async () => {
    setDemo(true)
    const el = await mount(<DemoNote />)
    expect(el.querySelector('.chat-demo-note')).toBeNull()
    await act(async () => void demoStop())
    expect(el.querySelector('.chat-demo-note-text')?.textContent).toBe(DEMO_NOTE)
    expect(DEMO_NOTE).toBe("This is a demo and thimble isn't connected to a live Claude Code session.")
    expect(DEMO_NOTE).not.toMatch(/your own|folder|run thimble/)
    expect(el.querySelectorAll('.chat-demo-note').length).toBe(1)
    await act(async () => void demoStop())
    expect(el.querySelectorAll('.chat-demo-note').length).toBe(1) // one note, however many actions
    await act(async () => (el.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click())
    expect(el.querySelector('.chat-demo-note')).toBeNull()
    await act(async () => void demoStop())
    expect(el.querySelector('.chat-demo-note')).not.toBeNull()
    await act(async () => dismissDemoNote())
  })

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

  test('outside a demo the composer takes typing and shows no tip', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await settle()
    expect((el.querySelector('.chat-composer textarea') as HTMLTextAreaElement).disabled).toBe(false)
    expect(el.querySelector('.chat-composer')?.hasAttribute('data-tipped')).toBe(false)
  })

  test("the tour's steps about the chat say it is a demo there, and stay as they were elsewhere", () => {
    const live = tourSteps('⌘', true, false)
    const demo = tourSteps('⌘', true, true)
    expect(live[0].title).toBe('Your Claude Code session')
    expect(live[0].body).toBe('This chat is your Claude Code session: ask it anything about the files.')
    expect(demo[0].title).toBe('The chat')
    expect(demo[0].body).toBe("This is a demo and thimble isn't connected to a live Claude Code session, so you can't type here. In a live session, this chat is your Claude Code session: ask it anything about the files.")
    expect(demo[0].body).not.toMatch(/folder of your own|run thimble/)
    expect(demo[1].body).not.toContain('where you started thimble.')
    expect(demo.some((s) => s.body === sessionTexts(true).ask)).toBe(true)
    expect(demo.length).toBe(live.length)
  })

  test("the tour's welcome says the line first on a demo page, then asks, and elsewhere only asks", () => {
    const welcome = (demo: boolean) => {
      setDemo(demo)
      const tour = runTour({ welcome: true, chat: true })
      const pop = document.querySelector('.tour-pop.tour-welcome') as HTMLElement
      const seen = {
        title: pop.querySelector('.tour-title')?.textContent,
        body: [...pop.querySelectorAll('.tour-body')].map((p) => p.textContent),
        code: [...pop.querySelectorAll('.tour-body code')].map((c) => c.textContent),
        buttons: [...pop.querySelectorAll('button')].map((b) => b.textContent),
      }
      tour.end()
      return seen
    }
    const asks = { title: 'Welcome to thimble', buttons: ['Skip', 'Take the tour'] }
    expect(welcome(true)).toEqual({ ...asks, body: [DEMO_LINE.replace(/`/g, ''), 'Would you like a short tour?'], code: ['thimble'] })
    expect(welcome(false)).toEqual({ ...asks, body: ['Would you like a short tour?'], code: [] })
  })
})
