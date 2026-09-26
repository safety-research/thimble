// @vitest-environment jsdom
// The chat off (src/shell/Shell.tsx, the workspace's `hide_chat`): the top bar's switch (src/shell/TopBar.tsx), the
// dock that holds main's foot without its composer (src/chat/ChatPanel.tsx `dock`) and shows nothing while nothing waits
// or runs, and the ⌘-click box that holds a thread's answer in place (src/pointer/PointerBox.tsx). The server is a
// stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { ANSWER_WIDTH, BOX_WIDTH, PointerBox } from '../../src/pointer/PointerBox.tsx'
import { CHAT_OFF_NOTE, SWITCHES } from '../../src/shell/SettingsPopover.tsx'
import { TopBar } from '../../src/shell/TopBar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

let mainMeta: Record<string, unknown> = {}
beforeEach(() => {
  mainMeta = { id: 'main', kind: 'main', orientation: 'or1', attached: { session: 's1' } }
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url)
    const body = u.endsWith('/chats/main') ? { meta: mainMeta, events: [] } : u.endsWith('/chats') ? [mainMeta] : u.endsWith('/settings') ? { models: {} } : u.endsWith('/corpora') ? [] : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe("the top bar's switch", () => {
  test('turns the chat off and on, and says which it does', async () => {
    const calls: boolean[] = []
    const el = await mount(<TopBar ws="mini" tabs={[]} onTab={() => undefined} onTabDrag={() => undefined} chatOff={false} onChatOff={(off) => calls.push(off)} />)
    const btn = el.querySelector<HTMLButtonElement>('.shell-chat-toggle')!
    expect(btn.getAttribute('aria-label')).toBe('Hide the chat')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    await act(async () => btn.click())
    expect(calls).toEqual([true])
    unmountAll()
    const off = await mount(<TopBar ws="mini" tabs={[]} onTab={() => undefined} onTabDrag={() => undefined} chatOff onChatOff={(v) => calls.push(v)} />)
    expect(off.querySelector('.shell-chat-toggle')!.getAttribute('aria-label')).toBe('Show the chat')
  })

  test('is also a switch in the settings, next to terminal-first', () => {
    expect(SWITCHES.map((s) => s.key)).toEqual(['hide_chat', 'terminal_first'])
    expect(CHAT_OFF_NOTE).toMatch(/dock/)
  })
})

describe('the dock', () => {
  test('shows nothing while nothing waits or runs, and no composer or transcript', async () => {
    const el = await mount(<ChatPanel ws="mini" dock />)
    await settle()
    await settle()
    expect(el.querySelector('.chat-dock')).toBeNull()
    expect(el.querySelector('.chat-composer, .chat-list')).toBeNull()
  })

  test("holds main's permission card, which still answers", async () => {
    mainMeta = { ...mainMeta, permissions: [{ id: 'h1', tool: 'Write', what: 'Write perm-probe.txt', since: '2026-09-26T07:00:00Z' }] }
    const el = await mount(<ChatPanel ws="mini" dock />)
    await settle()
    await settle()
    const dock = el.querySelector('.chat-dock')
    expect(dock).not.toBeNull()
    expect(dock!.querySelector('.chat-perm')).not.toBeNull()
    expect(dock!.querySelector('.chat-composer, .chat-list, .chat-head')).toBeNull()
  })

  test('holds the Start gate while no orientation was asked for', async () => {
    mainMeta = { id: 'main', kind: 'main', orientation: null, attached: { session: 's1' } }
    const el = await mount(<ChatPanel ws="mini" dock />)
    await settle()
    await settle()
    expect(el.querySelector('.chat-dock .chat-gate')).not.toBeNull()
  })
})

describe("the ⌘-click box's answer", () => {
  test('is wider, shows the thread above the field, and the field takes a reply', async () => {
    const rect = { left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40 }
    await mount(
      <PointerBox rect={rect} place={{ under: false }} label="Ask about this" draft="" onDraft={() => undefined} onSubmit={() => undefined} onClose={() => undefined} replyTo="pages-per-wiki">
        <p className="answer-probe">June 16.</p>
      </PointerBox>,
    )
    const box = document.querySelector<HTMLElement>('.pointer-box')!
    expect(box.querySelector('.pointer-box-answer .answer-probe')?.textContent).toBe('June 16.')
    expect(box.querySelector('textarea')?.getAttribute('placeholder')).toBe('Reply in pages-per-wiki…')
    expect(ANSWER_WIDTH).toBeGreaterThan(BOX_WIDTH)
  })
})
