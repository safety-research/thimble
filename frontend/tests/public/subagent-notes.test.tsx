// @vitest-environment jsdom
// What else the browser says about thimble's agents as subagents of main: the banner while main runs outside thimble's
// fence (src/shell/UnfencedBanner.tsx), the line on the session-gone card naming the agents main's quit stopped
// (src/shell/SessionGone.tsx), and in a thread, where each message came from, a follow-up not passed on with Send
// again, and the line when a typed follow-up ran on the role's current values (src/chat/Rows.tsx).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChipRow, byLabel, notPassedOn } from '../../src/chat/Rows.tsx'
import { stoppedAgentsLine } from '../../src/shell/SessionGone.tsx'
import { NO_SANDBOX_LINE, UNFENCED_LINE, UnfencedBanner, unfencedLine } from '../../src/shell/UnfencedBanner.tsx'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let posted: [string, unknown][] = []
beforeEach(() => {
  posted = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push([String(url), JSON.parse(String(init.body))])
    return new Response(JSON.stringify({ status: 'sent' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const attached = { session: 's', cwd: '/c', since: '' }

describe('the unfenced banner', () => {
  test('a plain claude, or a session without the sandbox, gets the warning; a fenced main and a meta that does not say get none', async () => {
    expect(unfencedLine({ attached, launched: false, fenced: false })).toBe(UNFENCED_LINE)
    expect(unfencedLine({ attached, launched: true, fenced: false })).toBe(NO_SANDBOX_LINE)
    expect(unfencedLine({ attached, launched: true, fenced: true })).toBeNull()
    expect(unfencedLine({ attached })).toBeNull()
    expect(unfencedLine({ attached: null, launched: false })).toBeNull()
    const el = await mount(<UnfencedBanner main={{ attached, launched: false, fenced: false }} />)
    expect(el.querySelector('.chat-unfenced')?.textContent).toBe(UNFENCED_LINE)
  })
})

describe('the session-gone card', () => {
  test("names the agents main's quit stopped, and how to continue the orientation", () => {
    const m = (extra: Partial<ChatMeta>) => ({ id: 'x', route: 'subagent', status: 'stopped', stopped_by: 'quit', ...extra }) as ChatMeta
    expect(stoppedAgentsLine([m({ role: 'orient' }), m({ role: 'writer', doc: 'report' }), m({ role: 'check', title: 'Unverified', stopped_by: 'analyst' })])).toBe(
      "thimble's agents stopped with it: the orientation and the writer of the report. Once it is back, send the orientation a message to continue it.",
    )
    expect(stoppedAgentsLine([m({ role: 'orient', status: 'done' })])).toBe('')
  })
})

describe('in a thread', () => {
  test('a message says where it came from: the agent tray or thimble; none in main', () => {
    expect(byLabel('terminal', 'o1')).toBe('typed in the agent tray')
    expect(byLabel('browser', 'o1')).toBe('sent from thimble')
    expect(byLabel('browser', 'main')).toBeNull()
  })

  test('a follow-up not passed on shows why and the message, and Send again sends it to the orientation', async () => {
    const el = await mount(<ChipRow ws="mini" item={{ kind: 'chip', index: 3, chip: 'not_passed_on', text: "thimble's module did not answer.", message: 'Does April look the same?' }} />)
    expect(el.textContent).toContain(notPassedOn("thimble's module did not answer."))
    expect(el.querySelector('.chat-not-passed-text')?.textContent).toBe('Does April look the same?')
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-send-again')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/orientation/message', { text: 'Does April look the same?' }]])
  })

  test('a typed follow-up that ran on the role\'s current values says so', async () => {
    const el = await mount(<ChipRow ws="mini" item={{ kind: 'chip', index: 4, chip: 'follow_up_ran_on', text: 'This message ran on claude-sonnet-5 · high, the role\'s current settings.' }} />)
    expect(el.querySelector('.chat-ran-on')?.textContent).toContain("the role's current settings")
  })
})
